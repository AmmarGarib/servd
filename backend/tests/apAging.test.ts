// AP aging, reconciled onto one implementation that ties to the ledger.
//
// What this guards:
//   - Withholding is fixed on the bill (SupplierBill.whtCents) when it is
//     recorded, and the ledger books that same figure: AP 2010 is credited
//     with total − WHT.
//   - ONE "still due" rule, net of withholding: payments can apply up to it,
//     a bill paid net of WHT is 'paid', and the petty-cash path agrees.
//   - ONE aging (procurement agingReport) behind /procurement/ap-aging, the
//     Procurement tab, the email and the supplier statement: due-date
//     buckets, unapplied payments as credits, opening balances apart,
//     suppliers with no company apart — and each company's total equals its
//     ledger AP 2010 balance. /procurement/aging is gone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { enforceModuleAccess } from '../src/lib/moduleAccess.js'
import { createBill, createPayment, allocatePayment, agingReport, billDueCents } from '../src/modules/procurement/service.js'
import { postSupplierBill, postSupplierPayment } from '../src/modules/accounting/supplierPosting.js'
import { buildApAgingReport } from '../src/workers/scheduledReports.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

let tenantA: string
let tenantB: string
let supA: string
let supA2: string
let orphan: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.aptest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const get = (who: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${users[who]!.token}` } })

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

async function bill(supplierId: string, number: string, costCents: number, dueDaysAgo: number) {
  const b = await createBill({
    supplierId, billNumber: number, billDate: daysAgo(dueDaysAgo + 10), dueDate: daysAgo(dueDaysAgo),
    lines: [{ description: 'Flour', quantity: 1, unitCostCents: costCents }],
    createdBy: users['ceo']!.id,
  })
  await postSupplierBill(b.id)
  return b
}

async function ledgerAp(tenantId: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code: '2010' } })
  const sums = await prisma.journalLine.groupBy({ by: ['type'], where: { accountId: acct.id }, _sum: { amountCents: true } })
  const cr = sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0
  const dr = sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0
  return cr - dr
}

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'AP B', slug: 'ap-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'AP A', slug: 'ap-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  // A withholds 4.5% at source; B does not withhold.
  await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, withholdingTaxEnabled: true, withholdingTaxPct: 0.045 } })
  invalidateSetupCache()

  supA   = (await prisma.supplier.create({ data: { name: 'Mill Co', tenantId: tenantA, paymentTermsDays: 10 } })).id
  supA2  = (await prisma.supplier.create({ data: { name: 'Dairy Co', tenantId: tenantA, paymentTermsDays: 10, openingBalanceCents: 70_000 } })).id
  orphan = (await prisma.supplier.create({ data: { name: 'Nobody Ltd', tenantId: null, paymentTermsDays: 10 } })).id
  await prisma.supplier.create({ data: { name: 'B Veg', tenantId: tenantB, paymentTermsDays: 10 } })

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('fin', 'finance', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

describe('withholding is fixed on the bill and booked from it', () => {
  it('stores WHT on the bill and credits AP with total − WHT', async () => {
    const b = await bill(supA, 'WHT-1', 100_000, 0)
    expect(b.whtCents).toBe(4_500)
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { reference: `supplier.bill:${b.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    const credit = (code: string) => je.lines.filter((l) => l.account.code === code && l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect(credit('2040')).toBe(4_500)
    expect(credit('2010')).toBe(95_500)
  })

  it('a bill paid net of withholding is paid; paying the gross is refused', async () => {
    const b = await bill(supA, 'WHT-2', 20_000, 0)          // WHT 900, owed 19,100
    await expect(createPayment({
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'bank_transfer', amountCents: 20_000,
      applications: [{ billId: b.id, amountAppliedCents: 20_000 }], createdBy: users['ceo']!.id,
    })).rejects.toMatchObject({ code: 'OVER_APPLIED' })

    const p = await createPayment({
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'bank_transfer', amountCents: 19_100,
      applications: [{ billId: b.id, amountAppliedCents: 19_100 }], createdBy: users['ceo']!.id,
    })
    await postSupplierPayment(p.id)
    const after = await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })
    expect(after.status).toBe('paid')
    expect(billDueCents(after)).toBe(0)
  })
})

describe('one AP aging, tied to ledger AP', () => {
  it('buckets by due date, net of WHT, with unapplied payments as credits and openings apart', async () => {
    const old = await bill(supA2, 'D-OLD', 40_000, 45)      // 31-60 past due, owed 38,200
    await bill(supA2, 'D-NEW', 10_000, -5)                    // not due yet, owed 9,550
    // A payment on account, part-applied: 5,000 applied to the old bill, 3,000 unapplied.
    const p = await createPayment({ supplierId: supA2, paymentDate: new Date().toISOString(), method: 'cash', amountCents: 8_000, createdBy: users['ceo']!.id })
    await allocatePayment(p.id, [{ billId: old.id, amountAppliedCents: 5_000 }])
    await postSupplierPayment(p.id)
    // The orphan supplier's bill never posts and is never in a company total.
    await bill(orphan, 'N-1', 12_345, 10)

    const r = await agingReport([tenantA])
    const dairy = r.bySupplier.find((s) => s.supplierId === supA2)!
    expect(dairy).toMatchObject({
      current: 9_550, '31_60': 38_200 - 5_000, creditsCents: 3_000,
      total: 9_550 + 33_200 - 3_000, openingCents: 0, openingUnpostedCents: 70_000, bills: 2,
    })
    expect(r.bySupplier.some((s) => s.supplierId === orphan)).toBe(false)
    expect(r.unassigned.bySupplier.map((s) => s.supplierId)).toEqual([orphan])
    expect(r.bySupplier.every((s) => s.tenantId === tenantA)).toBe(true)

    // Every company total equals its ledger AP 2010 balance.
    expect(r.total.total).toBe(await ledgerAp(tenantA))
  })

  it('fails closed on an empty scope', async () => {
    const r = await agingReport([])
    expect(r.bySupplier).toEqual([])
    expect(r.unassigned.bySupplier).toEqual([])
  })

  it('finance can open it (accounting module); the crashing /procurement/aging copy is gone', async () => {
    const res = await get('fin', '/procurement/ap-aging')
    expect(res.statusCode).toBe(200)
    expect((res.json() as { total: { total: number } }).total.total).toBe(await ledgerAp(tenantA))
    await expect(enforceModuleAccess('/api/v1/procurement/ap-aging', { role: 'finance' })).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/procurement/bills', { role: 'finance' })).rejects.toThrow()
    expect((await get('ceo', '/procurement/aging')).statusCode).toBe(404)
  })

  it('finance READS payables with its accounting module but never writes them (wave 3 UI-07)', async () => {
    // Reads pass on 'accounting'; a write needs 'procurement'.
    for (const url of ['/api/v1/procurement/bills', '/api/v1/procurement/payments', '/api/v1/procurement/purchase-orders?limit=5', '/api/v1/procurement/suppliers']) {
      await expect(enforceModuleAccess(url, { role: 'finance' }, 'GET'), url).resolves.toBeUndefined()
      await expect(enforceModuleAccess(url, { role: 'finance' }, 'POST'), url).rejects.toThrow(/module/)
    }
    // The rest of /procurement stays procurement-only, reads included.
    await expect(enforceModuleAccess('/api/v1/procurement/reorder', { role: 'finance' }, 'GET')).rejects.toThrow(/module/)
    // The CEO unticking accounting for finance closes the reads too.
    await expect(enforceModuleAccess('/api/v1/procurement/bills', { role: 'finance', moduleDeny: ['accounting'] }, 'GET')).rejects.toThrow(/module/)
    // A role with neither module is refused.
    await expect(enforceModuleAccess('/api/v1/procurement/bills', { role: 'cashier' }, 'GET')).rejects.toThrow(/module/)
    // Through the real middleware: finance lists bills (200), cannot enter one (403).
    expect((await get('fin', '/procurement/bills')).statusCode).toBe(200)
    const post = await app.inject({ method: 'POST', url: '/procurement/bills', headers: { authorization: `Bearer ${users['fin']!.token}` }, payload: {} })
    expect(post.statusCode).toBe(403)
  })

  it('the supplier statement reads the same row: ledger balance + opening', async () => {
    const res = await get('ceo', `/procurement/suppliers/${supA2}/statement`)
    const st = res.json() as { outstanding: number; ledgerOutstanding: number; openingBalanceCents: number }
    const row = (await agingReport([tenantA])).bySupplier.find((s) => s.supplierId === supA2)!
    expect(st.ledgerOutstanding).toBe(row.total)
    expect(st.outstanding).toBe(row.total)
  })

  it('the emailed AP aging is the same aging, for one company', async () => {
    const { subject, html } = await buildApAgingReport(tenantA)
    const r = await agingReport([tenantA], { includeUnassigned: false })
    expect(subject).toContain(`${r.total.bills} open bill(s)`)
    expect(html).toContain('Dairy Co')
    expect(html).not.toContain('Nobody Ltd')
    expect(html).not.toContain('B Veg')
  })
})
