// Test company (owner, 2026-10-14): public surfaces. A test company's brands
// are never ADVERTISED (storefront concepts + search, public locations, the
// WhatsApp brand menu, the custom-domain host map) but still work by direct
// slug, and those payloads carry isTestCompany. Documents of a test company
// are stamped TEST (receipt, pre-bill, tax invoice). Two companies side by
// side: the real one is unchanged.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { invalidateTestTenants } from '../src/lib/testCompany.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'
import { locationRoutes } from '../src/modules/locations/routes.js'
import { activeDomainHosts } from '../src/modules/domains/routes.js'
import { orderingBrands } from '../src/adapters/whatsapp/conversation.js'
import { buildReceiptData, buildReceiptHtml } from '../src/modules/pos/receipt.js'
import { renderInvoiceHtml } from '../src/modules/invoices/service.js'
import { readFileSync } from 'node:fs'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let realTenant = '', testTenant = ''
let realConcept = '', testConcept = ''
const realSlug = `pubreal-${RUN}`
const testSlug = `pubtest-${RUN}`

beforeAll(async () => {
  realTenant = (await prisma.tenant.create({ data: { name: 'Pub Real Co', slug: `pub-real-${RUN}` } })).id
  testTenant = (await prisma.tenant.create({ data: { name: 'Pub Test Co', slug: `pub-test-${RUN}`, isTest: true } })).id
  invalidateTestTenants()
  for (const [slug, tenantId] of [[realSlug, realTenant], [testSlug, testTenant]] as const) {
    const c = await prisma.concept.create({
      data: { name: `Zzpub ${slug}`, slug, type: 'restaurant', tenantId, storefrontVisible: true, isActive: true } as never,
    })
    if (tenantId === realTenant) realConcept = c.id; else testConcept = c.id
    const cat = await prisma.category.create({ data: { conceptId: c.id, name: 'Mains' } })
    await prisma.menuItem.create({ data: { conceptId: c.id, categoryId: cat.id, name: 'Zzpub dish', priceCents: 50_000 } as never })
    const loc = await prisma.location.create({ data: { slug: `loc-${slug}`, name: `Loc ${slug}`, tenantId } as never })
    await prisma.conceptLocation.create({ data: { conceptId: c.id, locationId: loc.id, isPrimary: true } })
    await prisma.domain.create({
      data: { tenantId, conceptId: c.id, hostname: `${slug}.example.test`, status: 'active', verificationToken: 'tok' } as never,
    })
  }
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    return reply.status(500).send({ error: String(err) })
  })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.register(locationRoutes, { prefix: '/locations' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('public listings hide a test company\'s brands', () => {
  it('/storefront/concepts lists the real brand, not the test brand', async () => {
    const res = await app.inject({ method: 'GET', url: '/storefront/concepts' })
    const slugs = (res.json() as Array<{ slug: string }>).map((c) => c.slug)
    expect(slugs).toContain(realSlug)
    expect(slugs).not.toContain(testSlug)
  })

  it('/storefront/search hides the test brand and its dishes', async () => {
    const res = await app.inject({ method: 'GET', url: '/storefront/search?q=zzpub' })
    const body = res.json() as { brands: Array<{ slug: string }>; items: Array<{ concept: { slug: string } }> }
    expect(body.brands.map((b) => b.slug)).toEqual([realSlug])
    expect(body.items.map((i) => i.concept.slug)).toEqual([realSlug])
  })

  it('/locations/public answers for the real brand, empty for the test brand', async () => {
    const real = await app.inject({ method: 'GET', url: `/locations/public?brand=${realSlug}` })
    const test = await app.inject({ method: 'GET', url: `/locations/public?brand=${testSlug}` })
    expect((real.json() as unknown[]).length).toBe(1)
    expect(test.json()).toEqual([])
  })

  it('the WhatsApp brand menu and the domain host map leave the test brand out', async () => {
    const brands = (await orderingBrands()).map((b) => b.slug)
    expect(brands).toContain(realSlug)
    expect(brands).not.toContain(testSlug)
    const hosts = (await activeDomainHosts()).map((h) => h.hostname)
    expect(hosts).toContain(`${realSlug}.example.test`)
    expect(hosts).not.toContain(`${testSlug}.example.test`)
  })
})

describe('direct-by-slug still works for a test brand and carries the flag', () => {
  it('/storefront/:concept/menu returns the test brand with isTestCompany true', async () => {
    const test = await app.inject({ method: 'GET', url: `/storefront/${testSlug}/menu` })
    expect(test.statusCode).toBe(200)
    expect(test.json().concept.isTestCompany).toBe(true)
    const real = await app.inject({ method: 'GET', url: `/storefront/${realSlug}/menu` })
    expect(real.statusCode).toBe(200)
    expect(real.json().concept.isTestCompany).toBe(false)
  })
})

describe('TEST stamps on documents', () => {
  async function completedOrder(conceptId: string) {
    return prisma.order.create({
      data: {
        conceptId, source: 'pos', status: 'completed', completedAt: new Date(),
        taxCents: 7_500, totalCents: 57_500,
        items: { create: [{ name: 'Dish', quantity: 1, unitPriceCents: 50_000 }] },
      } as never,
    })
  }

  it('the receipt of a test company\'s order carries the banner; a real one does not', async () => {
    const t = await completedOrder(testConcept)
    const r = await completedOrder(realConcept)
    expect((await buildReceiptData(t.id)).testCompany).toBe(true)
    expect((await buildReceiptData(r.id)).testCompany).toBe(false)
    expect(await buildReceiptHtml(t.id)).toContain('TEST COMPANY')
    expect(await buildReceiptHtml(r.id)).not.toContain('TEST COMPANY')
  })

  it('the tax invoice HTML is stamped TEST for a test company only', () => {
    const base = {
      invoiceNumber: 'INV-1', type: 'invoice', issuedAt: new Date(), sellerLegalName: 'Seller',
      subtotalCents: 100, discountCents: 0, taxableValueCents: 100, fbrTaxCents: 0, provincialTaxCents: 0,
      serviceChargeCents: 0, tipCents: 0, totalCents: 100, lines: [],
    }
    expect(renderInvoiceHtml({ ...base, testCompany: true })).toContain('TEST COMPANY')
    expect(renderInvoiceHtml(base)).not.toContain('TEST COMPANY')
  })

  it('the tablet printer mirrors the banner from ReceiptData.testCompany', () => {
    // printer.ts imports React Native's api client, so it cannot load under node: read the source.
    const src = readFileSync(new URL('../../tablet/src/lib/printer.ts', import.meta.url), 'utf8')
    expect(src).toContain('testCompany?:')
    expect(src).toContain("TEST_COMPANY_BANNER = 'TEST COMPANY - NOT A REAL SALE'")
    expect(src).toMatch(/order\.testCompany \? TEST_COMPANY_BANNER/)
  })
})
