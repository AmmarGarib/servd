// Re-sim UI stream (R2-UI, 2026-10-12). Regression tests for the admin-UI
// findings whose fixes touch code that can be exercised here:
//
//   R2-UI-01  the web till crashed ('reading filter') right after every
//             "Ring up and send to kitchen": POST /pos/orders answered without
//             `payments`, and the payment step read order.payments.filter.
//             The REAL admin till helpers (tillApi.ts) are run against the
//             REAL ring-up answer — only the browser API client is mocked.
//   R2-UI-03  HR's Rota reads the picker view. (The marketing tier of the
//             Brand Editor is gone: Brands is CEO only since 2026-10-14 —
//             /ceo/brands, GET ?view=brand and PATCH /concepts answer 403
//             BRAND_EDITOR_ONLY to roles without the brands module; tax / legal / look fields BRAND_FIELD_CEO_ONLY.) Two companies throughout.
//   R2-UI-05  the Z-report screen's rows (zReportLines): takings, money taken
//             on cancelled tickets, refunds, net sales, signed short/over.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, buildApp, caller, type Company, type Who } from './connectorsFixtures.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { AppError } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { invalidateModuleAccessCache } from '../src/lib/moduleAccess.js'

const apiPost = vi.fn()
vi.mock('/home/user/servd/frontend/admin/src/lib/api.ts', () => ({
  api: { get: vi.fn(), post: (...a: unknown[]) => apiPost(...a) },
  ApiError: class ApiError extends Error { status = 0; code: string | null = null },
}))

const till = await import('/home/user/servd/frontend/admin/src/components/pos/tillApi.ts')
const { fmtPkrWhole } = await import('/home/user/servd/frontend/admin/src/lib/money.ts')

let posApp: FastifyInstance
let conceptApp: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, drawerA: string
let conceptA2: string, conceptB2: string
let marketingA: Who, brandMgrA: Who, marketingB: Who, marketingDenied: Who, hrA: Who, managerA: Who, cashierA2: Who

const req = (who: Who, method: 'GET' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  conceptApp.inject({
    method, url,
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${who.token}`, ...headers },
  })

beforeAll(async () => {
  A = await mkCompany(`rsui-a-${Date.now()}`)
  B = await mkCompany(`rsui-b-${Date.now()}`)
  conceptA2 = (await prisma.concept.create({
    data: { name: 'Second A', slug: `rsui-a2-${Date.now()}`, type: 'restaurant', tenantId: A.tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8, strn: 'STRN-A2', fbrPosId: 4242 },
  })).id
  conceptB2 = (await prisma.concept.create({
    data: { name: 'Second B', slug: `rsui-b2-${Date.now()}`, type: 'restaurant', tenantId: B.tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8 },
  })).id
  cashierA = await mkUser('rsui-cashierA', 'cashier', A.tenantId)
  cashierA2 = await mkUser('rsui-cashierA2', 'cashier', A.tenantId)
  marketingA = await mkUser('rsui-marketingA', 'marketing', A.tenantId)
  brandMgrA = await mkUser('rsui-brandmgrA', 'brand_manager', A.tenantId)
  marketingB = await mkUser('rsui-marketingB', 'marketing', B.tenantId)
  marketingDenied = await mkUser('rsui-marketingDenied', 'marketing', A.tenantId)
  await prisma.user.update({ where: { id: marketingDenied.id }, data: { moduleDeny: ['brands'] } })
  hrA = await mkUser('rsui-hrA', 'hr', A.tenantId)
  managerA = await mkUser('rsui-managerA', 'management', A.tenantId)
  invalidateModuleAccessCache()

  posApp = await buildApp()
  call = caller(posApp)
  const o = await call(cashierA, 'POST', '/pos/shifts/open', { openingFloatCents: 500_000 })
  expect(o.statusCode, o.body).toBe(201)
  drawerA = o.json().id

  conceptApp = Fastify()
  conceptApp.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await conceptApp.register(conceptRoutes, { prefix: '/concepts' })
  await conceptApp.ready()
}, 60_000)

afterAll(async () => {
  invalidateSetupCache()
  await posApp?.close()
  await conceptApp?.close()
})

// ─── R2-UI-01 ────────────────────────────────────────────────────────────────

describe('R2-UI-01 — the till survives the ring-up answer', () => {
  const ringBody = (key: string) => ({
    conceptId: A.conceptId,
    idempotencyKey: key,
    shiftId: drawerA,
    discountCents: 0,
    paymentMethod: 'cash',
    items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
  })

  it('paidCentsOf / storedQuote treat a missing payments list as nothing paid', () => {
    const order = { id: 'o1', totalCents: 10_000, taxCents: 0, taxRatePct: 15, serviceChargeCents: 0, discountCents: 0 }
    expect(till.paidCentsOf({} as never)).toBe(0)
    expect(till.paidCentsOf({ payments: null } as never)).toBe(0)
    const q = till.storedQuote(order as never)
    expect(q.paidCents).toBe(0)
    expect(q.dueCents).toBe(10_000)
    expect(till.isUnpaid(order as never)).toBe(true)
  })

  it('the REAL POST /pos/orders answer, through ringUp(), reaches step 2 without throwing', async () => {
    const r = await call(cashierA, 'POST', '/pos/orders', ringBody(`pos-rsui-${Date.now()}`))
    expect(r.statusCode, r.body).toBe(201)
    const raw = r.json() as Record<string, unknown>
    const row = await prisma.order.findUniqueOrThrow({ where: { id: raw.id as string }, select: { totalCents: true, status: true } })

    // Whatever the API sends (with or without `payments`), ringUp normalises it.
    const withoutPayments = { ...raw }
    delete withoutPayments.payments
    for (const answer of [raw, withoutPayments]) {
      apiPost.mockResolvedValueOnce(answer)
      const rung = await till.ringUp(ringBody('k') as never)
      expect(till.isOfflinePlaceholder(rung)).toBe(false)
      const order = rung as Awaited<ReturnType<typeof till.ringUp>> & { payments: unknown[]; items: unknown[] }
      expect(Array.isArray(order.payments)).toBe(true)
      expect(Array.isArray(order.items)).toBe(true)
      const q = till.storedQuote(order as never)
      expect(q.paidCents).toBe(0)
      expect(q.dueCents).toBe(row.totalCents)
    }
  })

  it('an offline placeholder passes through untouched', async () => {
    // Today the placeholder comes from the till's own offline queue
    // (lib/offline-queue.ts), never from the server; whatever produces it,
    // the ring-up step must hand it back untouched.
    apiPost.mockResolvedValueOnce({ id: 'tmp-1', status: 'queued_offline' })
    const rung = await till.ringUp(ringBody('k') as never)
    expect(rung).toEqual({ id: 'tmp-1', status: 'queued_offline' })
  })
})

// ─── R2-UI-03 ────────────────────────────────────────────────────────────────

describe('R2-UI-03 — HR rota brand list (picker view)', () => {
  it('hr reads its own company\'s brands through ?view=picker; plain /concepts stays closed', async () => {
    const r = await req(hrA, 'GET', '/concepts?view=picker')
    expect(r.statusCode, r.body).toBe(200)
    const ids = (r.json() as Array<{ id: string }>).map((c) => c.id).sort()
    expect(ids).toEqual([A.conceptId, conceptA2].sort())
    expect((await req(hrA, 'GET', '/concepts')).statusCode).toBe(403)
  })
})

// Brands moved to the CEO workspace, CEO only (owner, 2026-10-14: "the brand
// editor needs to be moved to CEO stuff, because a lot of this stuff is not
// marketing related"). The marketing tier (R2-UI-03) and management's full
// edit are gone: GET ?view=brand and PATCH /concepts/:id answer 403
// BRAND_CEO_ONLY to every other role, whatever its modules.
describe('Brand Editor — marketing edits brand info, the CEO the rest (2026-10-20)', () => {
  let ceoA: Who
  beforeAll(async () => { ceoA = await mkUser('rsui-ceoA', 'admin', A.tenantId) })

  it('roles without the brands module (management, HR, a cashier, a marketer whose module is denied) are refused; nothing is written', async () => {
    const before = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })
    for (const who of [managerA, marketingDenied, hrA, cashierA2]) {
      const list = await req(who, 'GET', '/concepts?view=brand&includeInactive=1')
      expect(list.statusCode, `${who.role}: ${list.body}`).toBe(403)
      expect((await req(who, 'GET', `/concepts/${A.conceptId}?view=brand`)).statusCode).toBe(403)
      for (const body of [{ description: 'nope' }, { taxRateCash: 1 }, { name: 'Renamed' }, { sameAs: ['https://x.com/a'] }]) {
        const p = await req(who, 'PATCH', `/concepts/${A.conceptId}`, body)
        expect(p.statusCode, `${who.role}: ${p.body}`).toBe(403)
      }
    }
    expect(await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).toEqual(before)
  })

  it('marketing and the brand manager read rows marked "brand" and save brand info, never a tax field', async () => {
    for (const who of [marketingA, brandMgrA]) {
      const list = await req(who, 'GET', '/concepts?view=brand')
      expect(list.statusCode, list.body).toBe(200)
      expect((list.json() as Array<{ brandEditorAccess: string }>).every((c) => c.brandEditorAccess === 'brand')).toBe(true)
      expect((await req(who, 'PATCH', `/concepts/${A.conceptId}`, { description: `copy by ${who.role}` })).statusCode).toBe(200)
      const tax = await req(who, 'PATCH', `/concepts/${A.conceptId}`, { taxRateCash: 1 })
      expect(tax.json().error.code).toBe('BRAND_FIELD_CEO_ONLY')
    }
  })

  it('the CEO reads the full rows (every one marked full) and saves the whole brand, audited with the company', async () => {
    const r = await req(ceoA, 'GET', '/concepts?view=brand&includeInactive=1')
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows.map((c) => c.id)).toEqual(expect.arrayContaining([A.conceptId, conceptA2]))
    expect(rows.every((c) => c.brandEditorAccess === 'full')).toBe(true)
    expect(rows[0]).toHaveProperty('taxRateCash')
    const p = await req(ceoA, 'PATCH', `/concepts/${conceptA2}?view=brand`, { taxRateCash: 16, name: 'Second A renamed', description: 'CEO copy' })
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json().brandEditorAccess).toBe('full')
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })
    expect(row.taxRateCash).toBe(16)
    expect(row.name).toBe('Second A renamed')
    expect(row.description).toBe('CEO copy')
    const log = await prisma.auditLog.findFirst({ where: { entityId: conceptA2, action: 'concept.update' }, orderBy: { createdAt: 'desc' } })
    expect(log?.tenantId).toBe(A.tenantId)
    expect(log?.userId).toBe(ceoA.id)
  })

  it('company B\'s brand is 404 to company A\'s CEO (read and write)', async () => {
    expect((await req(ceoA, 'GET', `/concepts/${B.conceptId}?view=brand`)).statusCode).toBe(404)
    const p = await req(ceoA, 'PATCH', `/concepts/${B.conceptId}`, { description: 'hijack' })
    expect(p.statusCode, p.body).toBe(404)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: B.conceptId } })).description).not.toBe('hijack')
  })

  // RV-U-01: editing an EXISTING brand is 'write' scope — every company the
  // CEO belongs to — not 'create' (active company only).
  it('a multi-company CEO saves a member company\'s brand, stamped with that company', async () => {
    const multi = await mkUser('rsui-multi-admin', 'admin', A.tenantId)
    await prisma.tenantMember.create({ data: { userId: multi.id, tenantId: B.tenantId } })
    const list = await req(multi, 'GET', '/concepts?view=brand&includeInactive=1', undefined, { 'x-servd-portfolio': '1' })
    expect(list.statusCode, list.body).toBe(200)
    const ids = (list.json() as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining([A.conceptId, B.conceptId]))
    const p = await req(multi, 'PATCH', `/concepts/${conceptB2}?view=brand`, { description: 'saved by the CEO' })
    expect(p.statusCode, p.body).toBe(200)
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: conceptB2 }, select: { description: true, tenantId: true } })
    expect(row.description).toBe('saved by the CEO')
    expect(row.tenantId).toBe(B.tenantId)
    const log = await prisma.auditLog.findFirst({ where: { entityId: conceptB2, userId: multi.id }, orderBy: { createdAt: 'desc' } })
    expect(log?.tenantId).toBe(B.tenantId)
    // A non-member CEO still 404s.
    expect((await req(ceoA, 'PATCH', `/concepts/${conceptB2}`, { description: 'non-member' })).statusCode).toBe(404)
  })

  it('a CEO with no company at all is denied, never "no filter"', async () => {
    const orphan = await mkUser('rsui-orphan-ceo', 'admin', null)
    expect((await req(orphan, 'PATCH', `/concepts/${A.conceptId}`, { description: 'orphan' })).statusCode).toBe(404)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).description).not.toBe('orphan')
  })

  it('logo URLs: root-relative accepted, script / data refused, \'\' clears, absent leaves it', async () => {
    const m = await req(ceoA, 'PATCH', `/concepts/${conceptA2}?view=brand`, { logoUrl: '/marketing/logo.png', taxRateCash: 15, phone: '0300' })
    expect(m.statusCode, m.body).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })).logoUrl).toBe('/marketing/logo.png')
    expect((await req(ceoA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: 'javascript:alert(1)' })).statusCode).toBe(400)
    expect((await req(ceoA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: 'data:image/png;base64,AAAA' })).statusCode).toBe(400)
    expect((await req(ceoA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: '' })).statusCode).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })).logoUrl).toBeNull()
    await prisma.concept.update({ where: { id: conceptA2 }, data: { logoUrl: '/marketing/keep.png' } })
    expect((await req(ceoA, 'PATCH', `/concepts/${conceptA2}`, { phone: '0301' })).statusCode).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })).logoUrl).toBe('/marketing/keep.png')
  })

  it('the shell picker and the storefront view stay open to their roles', async () => {
    expect((await req(marketingA, 'GET', '/concepts?view=picker')).statusCode).toBe(200)
    expect((await req(marketingA, 'GET', '/concepts?view=storefront')).statusCode).toBe(200)
    expect((await req(managerA, 'GET', '/concepts')).statusCode).toBe(200)
    // Plain /concepts is still management / till only.
    expect((await req(marketingA, 'GET', '/concepts')).statusCode).toBe(403)
  })
})

describe('R2-UI-05 — the Z-report screen reconciles', () => {
  // The finding's drawer: a 1,725 pickup paid cash then cancelled and refunded
  // in cash, a 1,380 till sale, float 5,000, counted 6,300.
  const report = {
    cashSales: 310_500, cardSales: 0, walletSales: 0, totalSales: 310_500, totalOrders: 1,
    totalDiscounts: 0, totalTax: 18_000, expectedCashInDrawer: 638_000, actualCashInDrawer: 630_000,
    cashVariance: -8_000, openingFloatCents: 500_000, refundsCents: 172_500, cashRefundsCents: 172_500,
    netCents: 138_000, cancelledPaid: { count: 1, cashCents: 172_500, cardCents: 0 }, refundDueCents: 0,
    varianceLimitCents: 10_000, isBalanced: true,
  }
  const byLabel = (lines: Array<{ label: string; value: string; tone: string }>) => Object.fromEntries(lines.map((l) => [l.label, l]))

  it('shows takings, the cancelled-ticket money, refunds, net sales and a signed variance', () => {
    const l = byLabel(till.zReportLines(report, fmtPkrWhole))
    expect(l['Total takings']!.value).toBe('PKR 3,105')
    expect(l['of which on cancelled tickets (1)']!.value).toBe('PKR 1,725')
    expect(l['Refunds']!.value).toBe('-PKR 1,725')
    expect(l['of which cash from the drawer']!.value).toBe('PKR 1,725')
    expect(l['Net sales']!.value).toBe('PKR 1,380')
    expect(l['Opening float']!.value).toBe('PKR 5,000')
    expect(l['Expected cash']!.value).toBe('PKR 6,380')
    expect(l['Counted cash']!.value).toBe('PKR 6,300')
    // Inside the company's tolerance: amber, labelled, and SIGNED.
    expect(l['Variance (within tolerance)']).toMatchObject({ value: 'Short PKR 80', tone: 'amber' })
  })

  it('over / short / balanced', () => {
    expect(till.varianceWords(-8_000, fmtPkrWhole)).toBe('Short PKR 80')
    expect(till.varianceWords(12_000, fmtPkrWhole)).toBe('Over PKR 120')
    expect(till.varianceWords(0, fmtPkrWhole)).toBe('Balanced')
    const out = byLabel(till.zReportLines({ ...report, cashVariance: 50_000, isBalanced: false }, fmtPkrWhole))
    expect(out['Variance']).toMatchObject({ value: 'Over PKR 500', tone: 'red' })
  })

  it('an API without netCents falls back to takings less refunds; no refund lines when there were none', () => {
    const plain = { ...report, netCents: undefined, refundsCents: 0, cashRefundsCents: 0, cancelledPaid: { count: 0, cashCents: 0, cardCents: 0 }, totalSales: 138_000, cashSales: 138_000 }
    const l = byLabel(till.zReportLines(plain, fmtPkrWhole))
    expect(l['Net sales']!.value).toBe('PKR 1,380')
    expect(l['Refunds']).toBeUndefined()
    expect(Object.keys(l).some((k) => k.startsWith('of which on cancelled'))).toBe(false)
  })
})
