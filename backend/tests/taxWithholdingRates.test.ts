// Withholding rates and THE resolver (finance wave B, H8 / H28 —
// lib/withholding.ts, accounting/withholdingRoutes.ts).
//
//   • GET /accounting/withholding/rates: the ACTIVE company's switch and rates;
//     a company that never saved rates sees the CA placeholders, with its old
//     single withholdingTaxPct as the 153(1)(a) filer rate.
//   • PUT …/rates binds the ACTIVE company only (B still sees defaults), keeps
//     withholdingTaxPct = the 153(1)(a) filer rate, refuses a rate above 50%
//     (422), is admin / finance only and audited.
//   • computeWithholding: no section / switch off → 0; an exemption
//     certificate valid on the day → 0, expired → the filer rate with the ATL
//     check; non-filer → its rate; unknown → filer + needsAtlCheck; a snapshot
//     status wins over the supplier's; exact rounding up to the money cap.
//   • defaultSectionForCapex maps a CapEx line's treatment / project type.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { withholdingRoutes } from '../src/modules/accounting/withholdingRoutes.js'
import {
  computeWithholding, defaultSectionForCapex, withholdingRatesFor, DEFAULT_WHT_RATES, WHT_SECTIONS,
} from '../src/lib/withholding.js'
import { MAX_MONEY_CENTS } from '../src/lib/money.js'
import {
  AUTHORITIES, AUTHORITY_LIST, TAX_AUTHORITY_KEYS, OUTPUT_TAX_ACCOUNTS as TA_OUTPUT_TAX_ACCOUNTS,
  outputTaxCodeFor, inputTaxCodeFor, authorityOfOutputCode, authorityOfInputCode,
} from '../src/modules/accounting/taxAuthorities.js'
import { outputTaxCodeFor as legacyOutputTaxCodeFor, OUTPUT_TAX_ACCOUNTS } from '../src/modules/accounting/orderPosting.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string, tenantC: string

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string | null) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@whtrates.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  if (tenantId) await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

const ops = (tenantId: string) => prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })

beforeAll(async () => {
  tenantA = await company('WHT A')
  tenantB = await company('WHT B')
  tenantC = await company('WHT C')
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('fnbA', 'fnb_manager', tenantA)
  await mkStaff('adminB', 'admin', tenantB)
  await mkStaff('nobody', 'finance', null)
  // A ran withholding before wave B: switch on, the single % at 4.5%.
  await prisma.operationsConfig.create({ data: { tenantId: tenantA, scope: 'global', scopeId: null, withholdingTaxEnabled: true, withholdingTaxPct: 0.045 } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(withholdingRoutes, { prefix: '/accounting/withholding' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('withholding rates per company', () => {
  it('a company that never saved rates: CA placeholders, with its old % as the 153(1)(a) filer rate', async () => {
    const res = await call('finA', 'GET', '/accounting/withholding/rates')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ enabled: true, defaultsUsed: true, canEdit: true })
    expect(body.rates['153_1_a']).toEqual({ filerBps: 450, nonFilerBps: 1000 })
    expect(body.rates['153_1_b']).toEqual(DEFAULT_WHT_RATES['153_1_b'])
    expect(body.rates['155']).toEqual({ filerBps: 1500, nonFilerBps: 3000 })
    expect(body.sections.map((s: { key: string }) => s.key)).toEqual([...WHT_SECTIONS])
  })

  it('PUT binds the ACTIVE company only, keeps the % equal to the 153(1)(a) filer rate, and is audited', async () => {
    const res = await call('finA', 'PUT', '/accounting/withholding/rates', { rates: { '153_1_b': { filerBps: 1000, nonFilerBps: 2000 } } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ defaultsUsed: false })
    expect(res.json().rates['153_1_b']).toEqual({ filerBps: 1000, nonFilerBps: 2000 })
    // Sections not given keep what the company had (the legacy % included).
    expect(res.json().rates['153_1_a']).toEqual({ filerBps: 450, nonFilerBps: 1000 })
    expect((await ops(tenantA))!.withholdingTaxPct).toBeCloseTo(0.045, 10)

    const goods = await call('finA', 'PUT', '/accounting/withholding/rates', { rates: { '153_1_a': { filerBps: 600, nonFilerBps: 1200 } } })
    expect(goods.statusCode).toBe(200)
    const a = (await ops(tenantA))!
    expect(a.withholdingTaxPct).toBeCloseTo(0.06, 10)
    expect(a.withholdingRates).toMatchObject({ '153_1_a': { filerBps: 600, nonFilerBps: 1200 }, '153_1_b': { filerBps: 1000, nonFilerBps: 2000 } })
    expect(a.withholdingTaxEnabled).toBe(true) // the switch is not this route's

    const trail = await prisma.auditLog.findMany({ where: { action: 'withholding.rates_update', tenantId: tenantA } })
    expect(trail).toHaveLength(2)
    expect(trail.every((t) => t.category === 'accounting')).toBe(true)

    // B never saw any of it.
    const b = await call('adminB', 'GET', '/accounting/withholding/rates')
    expect(b.statusCode).toBe(200)
    expect(b.json()).toMatchObject({ enabled: false, defaultsUsed: true })
    expect(b.json().rates).toEqual(DEFAULT_WHT_RATES)
    expect(await ops(tenantB)).toBeNull()
  })

  it('B saving its own rates creates B\'s row and leaves A as it was', async () => {
    const res = await call('adminB', 'PUT', '/accounting/withholding/rates', { rates: { '155': { filerBps: 1000, nonFilerBps: 2000 } } })
    expect(res.statusCode).toBe(200)
    const b = (await ops(tenantB))!
    expect(b.withholdingRates).toMatchObject({ '155': { filerBps: 1000, nonFilerBps: 2000 }, '153_1_a': { filerBps: 500, nonFilerBps: 1000 } })
    expect(b.withholdingTaxPct).toBeCloseTo(0.05, 10)
    expect((await withholdingRatesFor(prisma, tenantA)).rates['155']).toEqual({ filerBps: 1500, nonFilerBps: 3000 })
  })

  it('a rate above 50%, below zero or for an unknown section is 422 and nothing changes', async () => {
    const before = (await ops(tenantA))!.withholdingRates
    const high = await call('finA', 'PUT', '/accounting/withholding/rates', { rates: { '153_1_c': { filerBps: 5001, nonFilerBps: 100 } } })
    expect(high.statusCode).toBe(422)
    expect(high.json().error.code).toBe('WHT_RATE_OUT_OF_RANGE')
    const low = await call('finA', 'PUT', '/accounting/withholding/rates', { rates: { '153_1_c': { filerBps: 100, nonFilerBps: -1 } } })
    expect(low.statusCode).toBe(422)
    const unknown = await call('finA', 'PUT', '/accounting/withholding/rates', { rates: { '236': { filerBps: 100, nonFilerBps: 100 } } })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json().error.code).toBe('BAD_WHT_SECTION')
    expect((await ops(tenantA))!.withholdingRates).toEqual(before)
  })

  it('a viewer reads but cannot save; no active company is 422', async () => {
    const view = await call('fnbA', 'GET', '/accounting/withholding/rates')
    expect(view.statusCode).toBe(200)
    expect(view.json().canEdit).toBe(false)
    const put = await call('fnbA', 'PUT', '/accounting/withholding/rates', { rates: { '155': { filerBps: 1, nonFilerBps: 1 } } })
    expect(put.statusCode).toBe(403)
    const none = await call('nobody', 'GET', '/accounting/withholding/rates')
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('NO_ACTIVE_COMPANY')
  })

  it('a malformed stored section falls back to its default', async () => {
    await prisma.operationsConfig.create({
      data: { tenantId: tenantC, scope: 'global', scopeId: null, withholdingTaxEnabled: true, withholdingRates: { '153_1_a': { filerBps: 'x' }, '153_1_b': { filerBps: 800, nonFilerBps: 1600 } } },
    })
    const r = await withholdingRatesFor(prisma, tenantC)
    expect(r.defaultsUsed).toBe(false)
    expect(r.rates['153_1_a']).toEqual(DEFAULT_WHT_RATES['153_1_a'])
    expect(r.rates['153_1_b']).toEqual({ filerBps: 800, nonFilerBps: 1600 })
  })
})

describe('computeWithholding — the one rule', () => {
  const at = new Date('2026-10-10T07:00:00Z')
  const filer = { filerStatus: 'filer', whtExemptUntil: null }

  it('no section → 0; services at the company\'s filer / non-filer rate', async () => {
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: null, baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 0, rateBps: 0, section: null })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '153_1_b', baseCents: 100_000, at }))
      .toEqual({ whtCents: 10_000, rateBps: 1000, section: '153_1_b', filerStatus: 'filer', exempt: false, needsAtlCheck: false })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { filerStatus: 'non_filer', whtExemptUntil: null }, section: '153_1_b', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 20_000, rateBps: 2000, filerStatus: 'non_filer', needsAtlCheck: false })
  })

  it('unknown → the filer rate and the ATL check; a snapshot status wins over the supplier\'s', async () => {
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { filerStatus: 'unknown', whtExemptUntil: null }, section: '155', baseCents: 200_000, at }))
      .toMatchObject({ whtCents: 30_000, rateBps: 1500, filerStatus: 'unknown', needsAtlCheck: true })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: null, section: '153_1_a', baseCents: 50_000, at }))
      .toMatchObject({ whtCents: 3_000, rateBps: 600, filerStatus: 'unknown', needsAtlCheck: true })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, filerStatus: 'non_filer', section: '153_1_a', baseCents: 50_000, at }))
      .toMatchObject({ whtCents: 6_000, rateBps: 1200, filerStatus: 'non_filer' })
  })

  it('an exemption certificate covers the day it is valid to, and not the day after', async () => {
    const cert = { filerStatus: 'exempt', whtExemptUntil: new Date('2026-10-10T18:59:59Z') }
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: cert, section: '153_1_c', baseCents: 100_000, at }))
      .toEqual({ whtCents: 0, rateBps: 0, section: '153_1_c', filerStatus: 'exempt', exempt: true, needsAtlCheck: false })
    // A filer holding a certificate is exempt while it is valid too.
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { ...cert, filerStatus: 'filer' }, section: '153_1_c', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 0, exempt: true })
    const after = new Date('2026-10-11T07:00:00Z')
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: cert, section: '153_1_c', baseCents: 100_000, at: after }))
      .toMatchObject({ whtCents: 7_000, rateBps: 700, filerStatus: 'unknown', exempt: false, needsAtlCheck: true })
    // 'exempt' with no certificate date proves nothing.
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { filerStatus: 'exempt', whtExemptUntil: null }, section: '153_1_c', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 7_000, needsAtlCheck: true })
  })

  it('the company\'s switch off → 0, whatever the section; another company\'s rates never apply', async () => {
    // B saved 155 at 10% but its switch is off.
    expect(await computeWithholding(prisma, { tenantId: tenantB, supplier: filer, section: '155', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 0, rateBps: 0 })
    await prisma.operationsConfig.updateMany({ where: { tenantId: tenantB }, data: { withholdingTaxEnabled: true } })
    expect(await computeWithholding(prisma, { tenantId: tenantB, supplier: filer, section: '155', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 10_000, rateBps: 1000 })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '155', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 15_000, rateBps: 1500 })
  })

  it('rounds half up on the paisa and stays exact up to the money cap', async () => {
    expect((await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '153_1_a', baseCents: 12_345, at })).whtCents).toBe(741) // 740.7
    expect((await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '155', baseCents: 3, at })).whtCents).toBe(0) // 0.45
    expect((await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '155', baseCents: 5, at })).whtCents).toBe(1) // 0.75
    expect((await computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '155', baseCents: MAX_MONEY_CENTS, at })).whtCents)
      .toBe(13_500_000_000_000)
    await expect(computeWithholding(prisma, { tenantId: tenantA, supplier: filer, section: '155', baseCents: MAX_MONEY_CENTS + 1, at }))
      .rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE' })
  })

  it('a CapEx line\'s usual section', () => {
    expect(defaultSectionForCapex('capital', 'kitchen_buildout')).toBe('153_1_c')
    expect(defaultSectionForCapex('capital', 'refurb')).toBe('153_1_c')
    expect(defaultSectionForCapex('capital', 'expansion')).toBe('153_1_c')
    expect(defaultSectionForCapex('capital', 'new_brand')).toBe('153_1_c')
    expect(defaultSectionForCapex('capital', 'equipment_only')).toBe('153_1_a')
    expect(defaultSectionForCapex('prepaid', 'kitchen_buildout')).toBe('155')
    expect(defaultSectionForCapex('expense', 'refurb')).toBe('153_1_b')
    expect(defaultSectionForCapex('deposit', 'kitchen_buildout')).toBeNull()
  })
})

describe('the authority table (accounting/taxAuthorities.ts)', () => {
  it('codes per authority; input and output codes map back', () => {
    // Only FBR and SRB (owner, 2026-10-15): PRA / KPRA / BRA were removed.
    expect(TAX_AUTHORITY_KEYS).toEqual(['fbr', 'srb'])
    expect(TAX_AUTHORITY_KEYS.map((k) => [AUTHORITIES[k].outputCode, inputTaxCodeFor(k)])).toEqual([
      ['2030', '1320'], ['2032', '1322'],
    ])
    for (const gone of ['pra', 'kpra', 'bra']) expect(() => inputTaxCodeFor(gone as never)).toThrow(/Unknown sales tax authority/)
    for (const code of ['2031', '2033', '2034']) expect(authorityOfOutputCode(code)).toBeNull()
    for (const code of ['1321', '1323', '1324']) expect(authorityOfInputCode(code)).toBeNull()
    for (const a of AUTHORITY_LIST) {
      expect(authorityOfOutputCode(a.outputCode)).toBe(a.key)
      expect(authorityOfInputCode(a.inputCode)).toBe(a.key)
    }
    expect(authorityOfOutputCode('2040')).toBeNull()
    expect(authorityOfInputCode('1335')).toBeNull()
    expect(() => inputTaxCodeFor('xyz' as never)).toThrow(/Unknown sales tax authority/)
  })

  it('the same answers as the order / shift posting (orderPosting.ts re-exports this in W2)', () => {
    const cases = [
      { province: 'SD', srbPosId: null }, { province: 'sd ', srbPosId: null }, { province: 'ICT', srbPosId: 7 },
      { province: null, srbPosId: 7 }, { province: null, srbPosId: null }, { province: '', srbPosId: null },
    ]
    for (const c of cases) expect(outputTaxCodeFor(c)).toBe(legacyOutputTaxCodeFor(c))
    // An unregistered province is refused by both, never booked to FBR.
    for (const province of ['PB', 'KP', 'BL']) {
      expect(() => outputTaxCodeFor({ province, srbPosId: null })).toThrow(expect.objectContaining({ code: 'PROVINCE_NOT_REGISTERED' }))
      expect(() => legacyOutputTaxCodeFor({ province, srbPosId: null })).toThrow(expect.objectContaining({ code: 'PROVINCE_NOT_REGISTERED' }))
    }
    expect(outputTaxCodeFor(null)).toBe('2030')
    expect([...TA_OUTPUT_TAX_ACCOUNTS]).toEqual([...OUTPUT_TAX_ACCOUNTS])
  })
})
