// Tax invoices per company (TaxInvoice.tenantId, migration 20261012120100).
//
// Before: invoiceNumber was globally unique and numbered per brand prefix —
// two companies whose brands use the same prefix both issued "<PFX>-2026-
// 00001", and the second was a 500 that also told company B that company A
// uses that prefix. Now numbers are unique per company and numbered per
// (company, prefix, year, invoice / credit note), race-safe under a series
// lock; the routes use lib/tenantScope.ts (foreign → 404).
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invoiceRoutes } from '../src/modules/invoices/routes.js'
import { issueInvoiceForOrder, issueCreditNoteForOrder, karachiYear } from '../src/modules/invoices/service.js'

const stamp = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string
let brandA: string, brandA2: string, brandB: string
const tokens: Record<string, string> = {}
const YEAR = karachiYear()

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@tinv.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: tokens[who]! } })
const order = async (conceptId: string) =>
  (await prisma.order.create({ data: { conceptId, source: 'pos', status: 'completed', completedAt: new Date(), totalCents: 115_000, taxCents: 15_000 } })).id
const brand = (name: string, tenantId: string) => prisma.concept.create({
  data: { name, slug: `${name.toLowerCase()}-tinv-${stamp}`, type: 'restaurant', tenantId, invoicePrefix: 'GSF', invoiceLegalName: `${name} (Pvt) Ltd`, strn: 'STRN-1' },
})

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (inv)', slug: `gs-inv-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (inv)', slug: `kb-inv-${stamp}` } })).id
  // Both companies print the SAME prefix on their invoices.
  brandA = (await brand('Stackd', tenantA)).id
  brandA2 = (await brand('Flipd', tenantA)).id
  brandB = (await brand('BunKebab', tenantB)).id
  await mkUser('mgrA', 'admin', tenantA)
  await mkUser('mgrB', 'admin', tenantB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(invoiceRoutes, { prefix: '/api/v1/invoices' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('tax invoices are numbered per company', () => {
  let invA: { id: string; invoiceNumber: string }
  let orderA: string

  it('the same prefix in two companies issues A\'s #1 and B\'s #1, each stamped with its company', async () => {
    orderA = await order(brandA)
    const a = await call('mgrA', 'POST', `/invoices/orders/${orderA}/issue`, {})
    expect(a.statusCode).toBe(201)
    invA = a.json()
    expect(a.json()).toMatchObject({ tenantId: tenantA, invoiceNumber: `GSF-${YEAR}-00001`, type: 'invoice' })

    const b = await call('mgrB', 'POST', `/invoices/orders/${await order(brandB)}/issue`, {})
    expect(b.statusCode).toBe(201) // was a 500 on the global unique index
    expect(b.json()).toMatchObject({ tenantId: tenantB, invoiceNumber: `GSF-${YEAR}-00001` })
    // Issuing again for an order returns the same invoice.
    expect((await call('mgrA', 'POST', `/invoices/orders/${orderA}/issue`, {})).json().id).toBe(invA.id)
  })

  it('company B gets 404 on A\'s invoice, A\'s order and A\'s brand', async () => {
    expect((await call('mgrB', 'GET', `/invoices/${invA.id}`)).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/invoices/${invA.id}/html`)).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/invoices/orders/${orderA}/issue`, {})).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/invoices/orders/${orderA}/credit-note`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/invoices?conceptId=${brandA}`)).statusCode).toBe(404)
    const listB = (await call('mgrB', 'GET', '/invoices')).json() as Array<{ tenantId: string }>
    expect(listB.length).toBe(1)
    expect(listB.every((i) => i.tenantId === tenantB)).toBe(true)
    expect((await call('mgrA', 'GET', `/invoices/${invA.id}`)).statusCode).toBe(200)
    expect((await call('mgrA', 'GET', `/invoices/${invA.id}/html`)).body).toContain(`GSF-${YEAR}-00001`)
    expect(await prisma.taxInvoice.count({ where: { orderId: orderA } })).toBe(1)
  })

  it('a concurrent pair in one company gets two different numbers; two brands of one company share the series', async () => {
    const [o1, o2] = [await order(brandA), await order(brandA2)]
    const [i1, i2] = await Promise.all([issueInvoiceForOrder({ orderId: o1 }), issueInvoiceForOrder({ orderId: o2 })])
    expect(new Set([i1.invoiceNumber, i2.invoiceNumber])).toEqual(new Set([`GSF-${YEAR}-00002`, `GSF-${YEAR}-00003`]))
    // Ten at once, still gap-free and distinct.
    const many = await Promise.all(Array.from({ length: 10 }, async () => issueInvoiceForOrder({ orderId: await order(brandA) })))
    const seqs = many.map((i) => Number(i.invoiceNumber.slice(-5))).sort((x, y) => x - y)
    expect(seqs).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    // The same order issued twice at once: one invoice.
    const o3 = await order(brandA)
    const [d1, d2] = await Promise.all([issueInvoiceForOrder({ orderId: o3 }), issueInvoiceForOrder({ orderId: o3 })])
    expect(d1.id).toBe(d2.id)
    expect(await prisma.taxInvoice.count({ where: { orderId: o3 } })).toBe(1)
  })

  it('a credit note carries the original\'s company, in that company\'s credit-note series', async () => {
    const cn = await call('mgrA', 'POST', `/invoices/orders/${orderA}/credit-note`, { reason: 'refunded' })
    expect(cn.statusCode).toBe(201)
    expect(cn.json()).toMatchObject({ tenantId: tenantA, type: 'credit_note', originalInvoiceId: invA.id, invoiceNumber: `GSF-${YEAR}-CN-00001`, totalCents: -15_000 })  // no items: the order's stored GST only
    // The credit note took no number from the invoice series.
    const next = await issueInvoiceForOrder({ orderId: await order(brandA) })
    expect(next.invoiceNumber).toBe(`GSF-${YEAR}-00015`)
    // Again for the same order: the same credit note.
    expect((await issueCreditNoteForOrder(orderA, 'again')).id).toBe(cn.json().id)
    // Company B's first credit note is its own #1.
    const bOrder = (await prisma.taxInvoice.findFirstOrThrow({ where: { tenantId: tenantB, type: 'invoice' } })).orderId
    expect((await issueCreditNoteForOrder(bOrder, 'refunded')).invoiceNumber).toBe(`GSF-${YEAR}-CN-00001`)
  })

  it('numbers by the Karachi calendar year', () => {
    expect(karachiYear(new Date('2026-12-31T19:30:00Z'))).toBe(2027) // 00:30 on 1 Jan in Karachi
    expect(karachiYear(new Date('2026-12-31T18:30:00Z'))).toBe(2026)
  })
})

describe('numbering is O(1): one counter row per series (D-RV-3)', () => {
  const series = (tenantId: string, head: string) =>
    prisma.taxInvoiceSeries.findUnique({ where: { tenantId_head: { tenantId, head } } })

  it('keeps a counter per (company, head): invoices and credit notes apart, companies apart', async () => {
    expect((await series(tenantA, `GSF-${YEAR}-`))?.lastValue).toBe(15)
    expect((await series(tenantA, `GSF-${YEAR}-CN-`))?.lastValue).toBe(1)
    expect((await series(tenantB, `GSF-${YEAR}-`))?.lastValue).toBe(1)
    expect((await series(tenantB, `GSF-${YEAR}-CN-`))?.lastValue).toBe(1)
  })

  it('the counter decides the number: no read of the company\'s invoice history on the normal path', async () => {
    // A series whose counter has not started, beside a number issued by hand
    // far ahead in it: the counter's next number (free) is used, where a
    // MAX() over the invoices would have jumped to 00051.
    const fast = (await prisma.concept.create({
      data: { name: 'Fast', slug: `fast-tinv-${stamp}`, type: 'restaurant', tenantId: tenantA, invoicePrefix: 'FAST', invoiceLegalName: 'Fast (Pvt) Ltd' },
    })).id
    const o = await order(fast)
    await prisma.taxInvoice.create({ data: { tenantId: tenantA, invoiceNumber: `FAST-${YEAR}-00050`, orderId: o, conceptId: fast, sellerLegalName: 'x', subtotalCents: 0, taxableValueCents: 0, totalCents: 0 } })
    expect((await issueInvoiceForOrder({ orderId: await order(fast) })).invoiceNumber).toBe(`FAST-${YEAR}-00001`)
    expect((await issueInvoiceForOrder({ orderId: await order(fast) })).invoiceNumber).toBe(`FAST-${YEAR}-00002`)
    expect((await series(tenantA, `FAST-${YEAR}-`))?.lastValue).toBe(2)
  })

  it('catches up once when an invoice already holds the next number (issued outside the counter)', async () => {
    const o = await order(brandA)
    // Invoices numbered outside the counter (an older release mid-deploy, or by hand).
    await prisma.taxInvoice.create({ data: { tenantId: tenantA, invoiceNumber: `GSF-${YEAR}-00016`, orderId: o, conceptId: brandA, sellerLegalName: 'x', subtotalCents: 0, taxableValueCents: 0, totalCents: 0 } })
    await prisma.taxInvoice.create({ data: { tenantId: tenantA, invoiceNumber: `GSF-${YEAR}-00020`, orderId: o, conceptId: brandA, sellerLegalName: 'x', subtotalCents: 0, taxableValueCents: 0, totalCents: 0 } })
    const next = await issueInvoiceForOrder({ orderId: await order(brandA) })
    // 16 was taken: the counter catches up with the highest issued (20), never a duplicate.
    expect(next.invoiceNumber).toBe(`GSF-${YEAR}-00021`)
    expect((await series(tenantA, `GSF-${YEAR}-`))?.lastValue).toBe(21)
    expect((await issueInvoiceForOrder({ orderId: await order(brandA) })).invoiceNumber).toBe(`GSF-${YEAR}-00022`)
    // Company B's series never moved.
    expect((await series(tenantB, `GSF-${YEAR}-`))?.lastValue).toBe(1)
  })

  it('the migration seeds each series from the invoices already issued, by type, and never lowers one', async () => {
    const tenantC = (await prisma.tenant.create({ data: { name: 'Legacy Co (inv)', slug: `lc-inv-${stamp}` } })).id
    const brandC = (await brand('Legacy', tenantC)).id
    const o = await order(brandC)
    const legacy = (invoiceNumber: string, type: 'invoice' | 'credit_note' = 'invoice') =>
      prisma.taxInvoice.create({ data: { tenantId: tenantC, invoiceNumber, type, orderId: o, conceptId: brandC, sellerLegalName: 'x', subtotalCents: 0, taxableValueCents: 0, totalCents: 0 } })
    await legacy('OLD-2025-00007')
    await legacy('OLD-2025-00012')
    await legacy('OLD-2025-CN-00003', 'credit_note')
    await legacy('OLD-2026-00002')
    // The old per-brand counter numbered credit notes in the invoice shape:
    // that number is taken in the invoice series.
    await legacy('OLD-2026-00005', 'credit_note')
    await legacy('A-2024-2025-00009')
    await legacy('MANUAL-1')
    const sql = readFileSync(new URL('../prisma/migrations/20261012120100_tax_invoice_company/migration.sql', import.meta.url), 'utf8')
    const seed = sql.slice(sql.indexOf('INSERT INTO "tax_invoice_series"'), sql.lastIndexOf(';'))
    expect(seed).toContain('ON CONFLICT')
    const before = (await series(tenantA, `GSF-${YEAR}-`))?.lastValue
    await prisma.$executeRawUnsafe(seed)
    await prisma.$executeRawUnsafe(seed) // re-runnable
    const rows = await prisma.taxInvoiceSeries.findMany({ where: { tenantId: tenantC }, orderBy: { head: 'asc' } })
    expect(rows.map((r) => [r.head, r.lastValue])).toEqual([
      ['A-2024-2025-', 9],
      ['OLD-2025-', 12],
      ['OLD-2025-CN-', 3],
      ['OLD-2026-', 5],
    ])
    expect((await series(tenantA, `GSF-${YEAR}-`))?.lastValue).toBe(before)
  })

  it('an old invoice-shaped credit note ahead of the counter is stepped over, never duplicated', async () => {
    const o = await order(brandA)
    const at = (await series(tenantA, `GSF-${YEAR}-`))!.lastValue
    const n = (k: number) => `GSF-${YEAR}-${String(k).padStart(5, '0')}`
    await prisma.taxInvoice.create({ data: { tenantId: tenantA, invoiceNumber: n(at + 1), type: 'credit_note', orderId: o, conceptId: brandA, sellerLegalName: 'x', subtotalCents: 0, taxableValueCents: 0, totalCents: 0 } })
    expect((await issueInvoiceForOrder({ orderId: await order(brandA) })).invoiceNumber).toBe(n(at + 2))
  })
})

