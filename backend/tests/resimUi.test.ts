// Re-sim UI stream (R2-UI, 2026-10-12). Regression tests for the admin-UI
// findings whose fixes touch code that can be exercised here:
//
//   R2-UI-01  the web till crashed ('reading filter') right after every
//             "Ring up and send to kitchen": POST /pos/orders answered without
//             `payments`, and the payment step read order.payments.filter.
//             The REAL admin till helpers (tillApi.ts) are run against the
//             REAL ring-up answer — only the browser API client is mocked.
//   R2-UI-03  the Brand Editor (/marketing/brands) for the 'brands' module
//             holders (marketing, brand_manager): GET /concepts?view=brand and
//             a PATCH limited to the marketing fields, any company the
//             operator belongs to ('write' scope; RV-U-01), audited; management keeps the full PATCH. HR's Rota reads the
//             picker view. Two companies throughout.
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
    apiPost.mockResolvedValueOnce({ id: 'tmp-1', status: 'queued_offline' })
    const rung = await till.ringUp({} as never)
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

describe('R2-UI-03 — Brand Editor for the marketing tier', () => {
  const FORBIDDEN_READ = ['taxRate', 'taxRateCash', 'taxRateCard', 'strn', 'ntn', 'fbrPosId', 'srbPosId', 'province',
    'invoiceLegalName', 'invoiceAddress', 'invoicePrefix', 'forecastPortionsPerMonth', 'storefrontLayout']

  it('marketing and brand_manager list their own company\'s brands with the editor row, no tax/legal/POS fields', async () => {
    for (const who of [marketingA, brandMgrA]) {
      const r = await req(who, 'GET', '/concepts?view=brand&includeInactive=1')
      expect(r.statusCode, r.body).toBe(200)
      const rows = r.json() as Array<Record<string, unknown>>
      expect(rows.map((c) => c.id).sort()).toEqual([A.conceptId, conceptA2].sort())
      for (const row of rows) {
        expect(row.brandEditorAccess).toBe('marketing')
        expect(row.tenantId).toBe(A.tenantId)
        expect(row).toHaveProperty('description')
        for (const f of FORBIDDEN_READ) expect(row).not.toHaveProperty(f)
      }
    }
  })

  it('company B\'s brand is 404 to company A\'s marketing (read and write)', async () => {
    expect((await req(marketingA, 'GET', `/concepts/${B.conceptId}?view=brand`)).statusCode).toBe(404)
    const p = await req(marketingA, 'PATCH', `/concepts/${B.conceptId}`, { description: 'hijack' })
    expect(p.statusCode, p.body).toBe(404)
    const b = await prisma.concept.findUniqueOrThrow({ where: { id: B.conceptId }, select: { description: true } })
    expect(b.description).not.toBe('hijack')
  })

  it('marketing saves the marketing fields; the change is audited with the company', async () => {
    const body = {
      description: 'Scratch café and market', heroTagline: 'stack it up', primaryColor: '#7C2946',
      conceptStatement: 'A café', cuisine: 'Café', priceTier: 'mid', daypartFocus: ['breakfast'], competitors: ['X'],
      brandVoice: 'Warm', wordmarkUrl: '/marketing/w.png', mascotUrl: '', logoUrl: 'https://media.example/l.png',
    }
    const r = await req(marketingA, 'PATCH', `/concepts/${A.conceptId}`, body)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().brandEditorAccess).toBe('marketing')
    expect(r.json()).not.toHaveProperty('taxRateCash')
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })
    expect(row.description).toBe('Scratch café and market')
    expect(row.heroTagline).toBe('stack it up')
    expect(row.primaryColor).toBe('#7C2946')
    expect(row.mascotUrl).toBeNull()
    expect(row.wordmarkUrl).toBe('/marketing/w.png')
    // Untouched management fields.
    expect(row.taxRateCash).toBe(15)
    expect(row.isActive).toBe(true)
    const log = await prisma.auditLog.findFirst({ where: { entityId: A.conceptId, action: 'concept.marketing_update' }, orderBy: { createdAt: 'desc' } })
    expect(log).not.toBeNull()
    expect(log!.tenantId).toBe(A.tenantId)
    expect(log!.userId).toBe(marketingA.id)
    expect((log!.after as Record<string, unknown>).description).toBe('Scratch café and market')
  })

  it.each([
    ['taxRateCash', 0], ['taxRateCard', 0], ['taxRate', 0], ['strn', 'X'], ['ntn', 'X'], ['fbrPosId', 1], ['srbPosId', 1],
    ['tenantId', 'other'], ['slug', 'new-slug'], ['isActive', false], ['name', 'Renamed'], ['whatsapp', '923000000000'],
    ['storefrontVisible', false], ['forecastPortionsPerMonth', 1], ['invoicePrefix', 'Z-'], ['storefrontLayout', []],
  ])('marketing cannot change %s — the whole PATCH is refused', async (field, value) => {
    const before = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })
    const r = await req(marketingA, 'PATCH', `/concepts/${conceptA2}`, { description: 'should not land', [field]: value })
    expect(r.statusCode, r.body).toBe(403)
    expect(r.json().error.code).toBe('FIELD_NOT_ALLOWED')
    const after = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })
    expect(after).toEqual(before)
  })

  it('a bad value is a 400, not a partial save', async () => {
    const r = await req(marketingA, 'PATCH', `/concepts/${conceptA2}`, { primaryColor: 'javascript:alert(1)' })
    expect(r.statusCode).toBe(400)
    const r2 = await req(marketingA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: 'javascript:alert(1)' })
    expect(r2.statusCode).toBe(400)
  })

  it('without the brands module (CEO untick / moduleDeny, or a role without it) the editor is closed', async () => {
    for (const who of [marketingDenied, hrA, cashierA2]) {
      expect((await req(who, 'GET', '/concepts?view=brand')).statusCode).toBe(403)
      expect((await req(who, 'PATCH', `/concepts/${A.conceptId}`, { description: 'nope' })).statusCode).toBe(403)
    }
    // Plain /concepts is still management / till only.
    expect((await req(marketingA, 'GET', '/concepts')).statusCode).toBe(403)
  })

  it('company B\'s marketing edits only B\'s brands', async () => {
    const r = await req(marketingB, 'GET', '/concepts?view=brand')
    expect((r.json() as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([B.conceptId, conceptB2].sort())
    expect((await req(marketingB, 'PATCH', `/concepts/${B.conceptId}`, { description: 'B copy' })).statusCode).toBe(200)
    expect((await req(marketingB, 'PATCH', `/concepts/${A.conceptId}`, { description: 'B on A' })).statusCode).toBe(404)
  })

  it('management keeps the full editor: full rows, full PATCH, never a non-member company', async () => {
    const r = await req(managerA, 'GET', '/concepts?view=brand&includeInactive=1')
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows.every((c) => c.brandEditorAccess === 'full')).toBe(true)
    expect(rows[0]).toHaveProperty('taxRateCash')
    const p = await req(managerA, 'PATCH', `/concepts/${conceptA2}`, { taxRateCash: 16, name: 'Second A renamed' })
    expect(p.statusCode, p.body).toBe(200)
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })
    expect(row.taxRateCash).toBe(16)
    expect(row.name).toBe('Second A renamed')
    const log = await prisma.auditLog.findFirst({ where: { entityId: conceptA2, action: 'concept.update' } })
    expect(log?.tenantId).toBe(A.tenantId)
    expect((await req(managerA, 'PATCH', `/concepts/${B.conceptId}`, { taxRateCash: 1 })).statusCode).toBe(404)
  })

  // RV-U-01: editing an EXISTING brand is 'write' scope — every company the
  // operator belongs to — not 'create' (active company only). The Brand
  // Editor lists a member company's brands in All-companies view, and the
  // admin client sends no x-servd-active-tenant on PATCH, so a save must land.
  it('a multi-company CEO / management / marketing saves a member company\'s brand; a non-member still 404s', async () => {
    const multi: Who[] = []
    for (const role of ['admin', 'management', 'marketing']) {
      const w = await mkUser(`rsui-multi-${role}`, role, A.tenantId)
      await prisma.tenantMember.create({ data: { userId: w.id, tenantId: B.tenantId } })
      multi.push(w)
    }
    invalidateModuleAccessCache()
    for (const who of multi) {
      const list = await req(who, 'GET', '/concepts?view=brand&includeInactive=1', undefined, { 'x-servd-portfolio': '1' })
      expect(list.statusCode, list.body).toBe(200)
      const ids = (list.json() as Array<{ id: string }>).map((c) => c.id)
      expect(ids).toContain(B.conceptId)
      expect(ids).toContain(A.conceptId)
      const text = `saved by ${who.role}`
      const p = await req(who, 'PATCH', `/concepts/${conceptB2}?view=brand`, { description: text })
      expect(p.statusCode, `${who.role}: ${p.body}`).toBe(200)
      const row = await prisma.concept.findUniqueOrThrow({ where: { id: conceptB2 }, select: { description: true, tenantId: true } })
      expect(row.description).toBe(text)
      expect(row.tenantId).toBe(B.tenantId) // never moved
      const log = await prisma.auditLog.findFirst({ where: { entityId: conceptB2, userId: who.id }, orderBy: { createdAt: 'desc' } })
      expect(log?.tenantId).toBe(B.tenantId) // stamped with the brand's company
    }
    // Same roles WITHOUT a membership in B: 404, nothing written.
    for (const who of [marketingA, managerA]) {
      const p = await req(who, 'PATCH', `/concepts/${conceptB2}`, { description: 'non-member' })
      expect(p.statusCode, p.body).toBe(404)
    }
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptB2 } })).description).not.toBe('non-member')
  })

  it('a staffer with no company at all is denied, never "no filter"', async () => {
    const orphan = await mkUser('rsui-orphan-mgmt', 'management', null)
    expect((await req(orphan, 'PATCH', `/concepts/${A.conceptId}`, { description: 'orphan' })).statusCode).toBe(404)
    const orphanMkt = await mkUser('rsui-orphan-mkt', 'marketing', null)
    invalidateModuleAccessCache()
    expect((await req(orphanMkt, 'PATCH', `/concepts/${A.conceptId}`, { description: 'orphan' })).statusCode).toBe(404)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).description).not.toBe('orphan')
  })

  // RV-U-02: one logoUrl rule for both tiers. A root-relative logo (what the
  // uploader returns when R2_PUBLIC_URL is unset) saved by marketing must not
  // make management's next full save — which resends logoUrl — fail with 400.
  it('a root-relative logo saved by marketing survives management\'s next full save', async () => {
    const m = await req(marketingA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: '/marketing/logo.png' })
    expect(m.statusCode, m.body).toBe(200)
    const full = await req(managerA, 'PATCH', `/concepts/${conceptA2}?view=brand`, { logoUrl: '/marketing/logo.png', taxRateCash: 15, phone: '0300' })
    expect(full.statusCode, full.body).toBe(200)
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })
    expect(row.logoUrl).toBe('/marketing/logo.png')
    expect(row.taxRateCash).toBe(15)
    // The full schema still refuses script/data URLs and still clears on ''.
    expect((await req(managerA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: 'javascript:alert(1)' })).statusCode).toBe(400)
    expect((await req(managerA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: 'data:image/png;base64,AAAA' })).statusCode).toBe(400)
    expect((await req(managerA, 'PATCH', `/concepts/${conceptA2}`, { logoUrl: '' })).statusCode).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })).logoUrl).toBeNull()
    // An absent logoUrl leaves the stored one alone.
    await prisma.concept.update({ where: { id: conceptA2 }, data: { logoUrl: '/marketing/keep.png' } })
    expect((await req(managerA, 'PATCH', `/concepts/${conceptA2}`, { phone: '0301' })).statusCode).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })).logoUrl).toBe('/marketing/keep.png')
  })
})

// ─── R2-UI-05 ────────────────────────────────────────────────────────────────

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
