// workers/scheduledReports.ts — the 'food_cost' and 'menu_engineering'
// schedules (finance wave B).
//
// What this guards:
//   - a food_cost schedule emails ONLY its own company's food cost (the ONE
//     engine, reports/foodCost.ts buildFoodCostEmail): another company's
//     brands and items never appear;
//   - revenue only when the schedule's creator is a FINANCIALS_VIEWER;
//   - a schedule with no company is recorded 'failed: no company' and sends
//     nothing — never run unscoped;
//   - an unknown report type is recorded 'failed: …' (no placeholder email);
//   - menu_engineering runs the Sales quadrants report for the company's brands.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const sent: Array<{ to: string; subject: string; html: string }> = []
vi.mock('../src/lib/notify.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/notify.js')>()
  return { ...real, sendEmail: vi.fn(async (to: string, subject: string, html: string) => { sent.push({ to, subject, html }) }) }
})

const { prisma, mkCompany, mkUser } = await import('./connectorsFixtures.js')
const { fifoCutoverKey, addLotTx, consumeFifoTx, STOCK_SOURCE } = await import('../src/lib/stockLedger.js')
const { runScheduledReport } = await import('../src/workers/scheduledReports.js')
const { foodCostEmailPeriod } = await import('../src/modules/reports/foodCost.js')

const RUN = Date.now()
let A: Awaited<ReturnType<typeof mkCompany>>
let B: Awaited<ReturnType<typeof mkCompany>>
let financeA: string
let bohA: string

async function schedule(data: { tenantId: string | null; reportType: string; createdById?: string | null; conceptId?: string | null; lastRunAt?: Date | null }) {
  return prisma.scheduledReport.create({
    data: {
      tenantId: data.tenantId, name: `FC ${data.reportType}`, reportType: data.reportType, cron: '0 6 * * 1',
      recipients: ['owner@example.com'], conceptId: data.conceptId ?? null, createdById: data.createdById ?? null, lastRunAt: data.lastRunAt ?? null,
    },
  })
}

beforeAll(async () => {
  A = await mkCompany(`sfc-a-${RUN}`)
  B = await mkCompany(`sfc-b-${RUN}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(RUN - 60 * 86_400_000).toISOString() } })
  financeA = (await mkUser('sfc-fin', 'finance', A.tenantId)).id
  bohA = (await mkUser('sfc-boh', 'boh_management', A.tenantId)).id
  // An unexplained ingredient in each company, named so a leak would show.
  for (const [co, name] of [[A, 'Alpha Saffron'], [B, 'Bravo Truffle']] as const) {
    const item = (await prisma.inventoryItem.create({ data: { tenantId: co.tenantId, name, unit: 'kg', category: 'dry_goods' } })).id
    const src = `sfc-${name}`
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: co.tenantId, inventoryItemId: item, qty: 10, unitCostCents: 100_000, kind: 'opening', lotSourceType: 'opening', lotSourceId: src,
      movementSourceType: 'test.opening', movementSourceId: src, receivedAt: new Date(RUN - 20 * 86_400_000),
    }))
    const count = await prisma.physicalCount.create({ data: { tenantId: co.tenantId, countedById: financeA, kind: 'spot' } })
    const line = await prisma.physicalCountLine.create({ data: { countId: count.id, inventoryItemId: item, systemQty: 10, physicalQty: 9 } })
    await prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: co.tenantId, inventoryItemId: item, qty: 1, kind: 'count_loss', sourceType: STOCK_SOURCE.countLine, sourceId: line.id, clamp: false,
      occurredAt: new Date(RUN - 2 * 86_400_000),
    }))
  }
}, 60_000)

beforeEach(() => { sent.length = 0 })

describe('food_cost schedules', () => {
  it('email only the schedule\'s own company', async () => {
    const s = await schedule({ tenantId: A.tenantId, reportType: 'food_cost', createdById: financeA })
    await runScheduledReport(s.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('owner@example.com')
    expect(sent[0]!.subject).toContain(`Co sfc-a-${RUN}`)
    expect(sent[0]!.html).toContain('Alpha Saffron')
    expect(sent[0]!.html).not.toContain('Bravo Truffle')
    expect(sent[0]!.html).not.toContain(`Co sfc-b-${RUN}`)
    // Finance created it: sales figures are in.
    expect(sent[0]!.html).toContain('Brand sales')
    const after = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })
    expect(after.lastStatus).toBe('success')
    expect(after.lastRunAt).not.toBeNull()
  })

  it('no revenue when the creator is not a financials viewer', async () => {
    const s = await schedule({ tenantId: A.tenantId, reportType: 'food_cost', createdById: bohA })
    await runScheduledReport(s.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.html).not.toContain('Brand sales')
    expect(sent[0]!.html).toContain('Alpha Saffron')
  })

  it('a schedule naming another company\'s brand fails, sends nothing', async () => {
    const s = await schedule({ tenantId: A.tenantId, reportType: 'food_cost', createdById: financeA, conceptId: B.conceptId })
    await expect(runScheduledReport(s.id)).rejects.toThrow()
    expect(sent).toHaveLength(0)
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).lastStatus).toMatch(/^failed: /)
  })

  it('a schedule with no company is recorded "failed: no company" and sends nothing', async () => {
    const s = await schedule({ tenantId: null, reportType: 'food_cost', createdById: financeA })
    await expect(runScheduledReport(s.id)).rejects.toThrow('no company')
    expect(sent).toHaveLength(0)
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).lastStatus).toBe('failed: no company')
  })

  it('the period: since the last run, else the previous 7 PKT days', () => {
    const now = new Date('2026-10-14T06:00:00Z')   // 11:00 PKT, 14 Oct
    const last = new Date('2026-10-10T01:00:00Z')
    expect(foodCostEmailPeriod(last, now)).toEqual({ from: last, to: now })
    const p = foodCostEmailPeriod(null, now)
    expect(p.from.toISOString()).toBe('2026-10-06T19:00:00.000Z')   // 7 Oct 00:00 PKT
    expect(p.to.toISOString()).toBe('2026-10-13T18:59:59.999Z')     // 13 Oct 23:59:59.999 PKT
  })
})

describe('other report types', () => {
  it('an unknown type is recorded failed, never a placeholder email', async () => {
    const s = await schedule({ tenantId: A.tenantId, reportType: 'bogus_report' })
    await expect(runScheduledReport(s.id)).rejects.toThrow()
    expect(sent).toHaveLength(0)
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).lastStatus).toMatch(/^failed: report type 'bogus_report'/)
  })

  it('menu_engineering runs the Sales quadrants report for the company\'s brands only', async () => {
    const s = await schedule({ tenantId: A.tenantId, reportType: 'menu_engineering' })
    await runScheduledReport(s.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.html).toContain(`Brand sfc-a-${RUN}`)
    expect(sent[0]!.html).not.toContain(`Brand sfc-b-${RUN}`)
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).lastStatus).toBe('success')
  })
})
