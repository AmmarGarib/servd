// Period-close checklist go-live (owner, 2026-10-24: "it should implement from November 1st onwards").
// Before CLOSE_CHECKS_FROM a block is shown as a warning (the trial balance excepted); from it on, a till left
// open before the go-live never blocks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { closeChecklist } from '../src/modules/accounting/closeChecks.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantId: string
const saved = process.env.CLOSE_CHECKS_FROM_OVERRIDE

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: `GoLive ${RUN}`, slug: `golive-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  const u = await prisma.user.create({ data: { name: 'Old Till', email: `oldtill.${RUN}@golive.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId } })
  // A drawer opened in May and never closed.
  await prisma.shift.create({ data: { userId: u.id, tenantId, status: 'open', openingFloatCents: 0, openedAt: new Date('2026-05-11T10:00:00+05:00') } })
  process.env.CLOSE_CHECKS_FROM_OVERRIDE = '2026-11-01T00:00:00+05:00'
})
afterAll(() => { process.env.CLOSE_CHECKS_FROM_OVERRIDE = saved })

describe('period close go-live', () => {
  it('a close before 1 Nov: the open till is a warning naming the cashier, nothing blocks', async () => {
    const c = await closeChecklist(prisma, tenantId, new Date('2026-10-31T23:59:59.999+05:00'))
    expect(c.blocks.filter((b) => b.key !== 'trial_balance')).toHaveLength(0)
    const till = c.warnings.find((w) => w.key === 'open_tills')!
    expect(till.detail).toContain('Old Till')
    expect(till.detail).toContain('not blocking')
  })
  it('a close after 1 Nov: the May till does not block; a till opened in November does', async () => {
    const c = await closeChecklist(prisma, tenantId, new Date('2026-11-30T23:59:59.999+05:00'))
    expect(c.problems.some((p) => p.key === 'open_tills')).toBe(false)
    const u = await prisma.user.findFirstOrThrow({ where: { tenantId } })
    await prisma.shift.create({ data: { userId: u.id, tenantId, status: 'open', openingFloatCents: 0, openedAt: new Date('2026-11-05T10:00:00+05:00') } })
    const c2 = await closeChecklist(prisma, tenantId, new Date('2026-11-30T23:59:59.999+05:00'))
    expect(c2.blocks.find((b) => b.key === 'open_tills')).toBeTruthy()
  })
})
