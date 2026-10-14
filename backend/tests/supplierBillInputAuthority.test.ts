// Supplier bill tax fields (finance wave B, H8 / H28).
//
//   - Input tax by the authority that charged it: an SRB-tagged bill debits
//     1322 in the supplier's company (the supplier's usual authority is the
//     default; a bill can name another); its credit note credits that same
//     code back.
//   - Withholding through the ONE resolver (lib/withholding.ts): by section ×
//     filer status, the supplier's exemption certificate (valid through the
//     END of its PKT day), 'none' withholds nothing; the bill stores
//     whtSection / whtRateBps and the ledger books its whtCents.
//   - Company B creating a bill against company A's supplier is 404.
//   - The OpEx / CapEx vendor picker (GET /procurement/suppliers?view=picker)
//     lists the category's company's suppliers only — a foreign category or
//     company is 404 — and never the system supplier.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { parsePktEndOfDay, pktToday, fmtPktDate } from '../src/modules/accounting/dates.js'
import { ensureCashPurchaseSupplier } from '../src/modules/procurement/receiving.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string, catA: string, catB: string
let supSrb: string, supNonFiler: string, supExempt: string, supB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
let n = 0

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@billtax.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })
const billBody = (supplierId: string, extra: Record<string, unknown> = {}) => ({
  supplierId, billNumber: `BT-${++n}-${RUN}`, billDate: new Date().toISOString(), taxCents: 13_000,
  lines: [{ description: 'Hood duct repair', quantity: 1, unitCostCents: 100_000, expenseAccountCode: '6050' }],
  ...extra,
})
async function entryOf(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  const out: Record<string, number> = {}
  for (const l of je.lines) out[l.account.code] = (out[l.account.code] ?? 0) + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents))
  return { net: out, lines: je.lines }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'BT A', slug: `bt-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'BT B', slug: `bt-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  // A withholds (the CA placeholder rates: services 9% filer / 18% non-filer, goods 5% / 10%).
  await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, withholdingTaxEnabled: true, withholdingTaxPct: 0 } })
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  catA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Repairs', expenseAccountCode: '6050' } })).id
  catB = (await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Repairs', expenseAccountCode: '6050' } })).id
  supB = (await prisma.supplier.create({ data: { name: `BT B Vendor ${RUN}`, tenantId: tenantB } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()

  // The tax profile is set on the supplier (the ONE vendor master).
  const srb = await call('ceoA', 'POST', '/procurement/suppliers', {
    name: `Sindh Services ${RUN}`, taxId: '1234567-8', filerStatus: 'filer', defaultTaxAuthority: 'srb', defaultWhtSection: '153_1_b',
  })
  expect(srb.statusCode, srb.body).toBe(201)
  supSrb = srb.json().id
  supNonFiler = (await call('ceoA', 'POST', '/procurement/suppliers', { name: `Cash Fixer ${RUN}`, filerStatus: 'non_filer', defaultWhtSection: '153_1_b' })).json().id
  supExempt = (await call('ceoA', 'POST', '/procurement/suppliers', { name: `Exempt Co ${RUN}`, filerStatus: 'filer', defaultWhtSection: '153_1_b' })).json().id
})

afterAll(async () => { invalidateSetupCache(); await app.close() })

describe('input tax by the authority that charged it', () => {
  let srbBill: { id: string; lineId: string }

  it('an SRB supplier\'s bill: Dr 1322 in its company, WHT at the services filer rate, all stored on the bill', async () => {
    const r = await call('ceoA', 'POST', '/procurement/bills', billBody(supSrb))
    expect(r.statusCode, r.body).toBe(201)
    const b = r.json()
    expect(b).toMatchObject({ taxAuthority: 'srb', whtSection: '153_1_b', whtRateBps: 900, whtCents: 9_000, totalCents: 113_000 })
    srbBill = { id: b.id, lineId: b.lines[0].id }
    const { net, lines } = await entryOf(tenantA, `supplier.bill:${b.id}`)
    expect(net).toEqual({ '6050': 100_000, '1322': 13_000, '2040': -9_000, '2010': -104_000 })
    expect(lines.find((l) => l.account.code === '1322')!.memo).toMatch(/SRB/)
    expect(lines.find((l) => l.account.code === '2040')!.memo).toMatch(/153\(1\)\(b\).*9\.00%/)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `supplier.bill:${b.id}` } })).toBe(0)
  })

  it('its credit note credits 1322 back (the bill\'s own input code)', async () => {
    const r = await call('ceoA', 'POST', `/procurement/bills/${srbBill.id}/credit-notes`, {
      number: `BT-CN-${RUN}`, date: new Date().toISOString(), reason: 'price', taxCents: 1_300, applyToBill: false,
      lines: [{ billLineId: srbBill.lineId, qty: 1, unitCostCents: 10_000 }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const { net } = await entryOf(tenantA, `supplier.credit_note:${r.json().id}`)
    expect(net).toEqual({ '2010': 10_400, '2040': 900, '6050': -10_000, '1322': -1_300 })
  })

  it('a bill can name another authority and section: FBR goods → 1320 at 5%', async () => {
    const r = await call('ceoA', 'POST', '/procurement/bills', billBody(supSrb, { taxAuthority: 'fbr', whtSection: '153_1_a' }))
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ taxAuthority: 'fbr', whtSection: '153_1_a', whtRateBps: 500, whtCents: 5_000 })
    expect((await entryOf(tenantA, `supplier.bill:${r.json().id}`)).net).toMatchObject({ '1320': 13_000, '2040': -5_000 })
  })
})

describe('withholding through the one resolver', () => {
  it('a non-filer pays the double rate', async () => {
    const r = await call('ceoA', 'POST', '/procurement/bills', billBody(supNonFiler))
    expect(r.json()).toMatchObject({ whtSection: '153_1_b', whtRateBps: 1_800, whtCents: 18_000, taxAuthority: 'fbr' })
  })

  it('an exemption certificate valid today covers the whole PKT day (stored as its last instant): nothing withheld', async () => {
    const today = fmtPktDate(pktToday().from)
    const p = await call('ceoA', 'PATCH', `/procurement/suppliers/${supExempt}`, { whtExemptCertNo: 'EX-153-2026-77', whtExemptUntil: today })
    expect(p.statusCode, p.body).toBe(200)
    const stored = await prisma.supplier.findUniqueOrThrow({ where: { id: supExempt } })
    expect(stored.whtExemptUntil!.toISOString()).toBe(parsePktEndOfDay(today).toISOString())
    expect(stored.whtExemptCertNo).toBe('EX-153-2026-77')
    const r = await call('ceoA', 'POST', '/procurement/bills', billBody(supExempt))
    expect(r.json()).toMatchObject({ whtCents: 0, whtRateBps: 0 })
  })

  it("'none' withholds nothing and is stored as such", async () => {
    const r = await call('ceoA', 'POST', '/procurement/bills', billBody(supSrb, { whtSection: 'none' }))
    expect(r.json()).toMatchObject({ whtSection: 'none', whtCents: 0 })
  })
})

describe('company separation', () => {
  it('company B creating a bill against company A\'s supplier is 404; nothing saved', async () => {
    const r = await call('ceoB', 'POST', '/procurement/bills', billBody(supSrb, { billNumber: `BT-X-${RUN}` }))
    expect(r.statusCode).toBe(404)
    expect(await prisma.supplierBill.count({ where: { billNumber: `BT-X-${RUN}` } })).toBe(0)
  })

  it('the vendor picker lists the category\'s company\'s suppliers (with their tax profile) — never the system supplier; foreign → 404', async () => {
    await prisma.$transaction((tx) => ensureCashPurchaseSupplier(tx, tenantA))
    const r = await call('ceoA', 'GET', `/procurement/suppliers?view=picker&categoryId=${catA}`)
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json() as Array<{ id: string; name: string; filerStatus: string; defaultTaxAuthority: string | null }>
    expect(rows.map((s) => s.id).sort()).toEqual([supSrb, supNonFiler, supExempt].sort())
    expect(rows.find((s) => s.id === supSrb)).toMatchObject({ filerStatus: 'filer', defaultTaxAuthority: 'srb', defaultWhtSection: '153_1_b' })
    expect(Object.keys(rows[0]!).sort()).toEqual(['defaultTaxAuthority', 'defaultWhtSection', 'filerStatus', 'id', 'name', 'whtExemptUntil'])
    expect((await call('ceoA', 'GET', `/procurement/suppliers?view=picker&categoryId=${catB}`)).statusCode).toBe(404)
    expect((await call('ceoA', 'GET', `/procurement/suppliers?view=picker&tenantId=${tenantB}`)).statusCode).toBe(404)
    const b = await call('ceoB', 'GET', `/procurement/suppliers?view=picker&categoryId=${catB}`)
    expect((b.json() as Array<{ id: string }>).map((s) => s.id)).toEqual([supB])
  })
})
