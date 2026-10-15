// Trash bin — marketing & content (Stream B4; modules/trash/README.md).
//
//   - Two companies: company B gets 404 on company A's deletes, entries,
//     restores and purges; entries carry the ROW's company.
//   - A trashed promo code is NOT redeemable (lib/promoEval.ts), re-creating the
//     code while the old one is trashed works, restoring it then asks for a new
//     code (TRASH_CLASH with a suggestion); a used promo is not erasable.
//   - A calendar event comes back with its social post (never auto-published).
//   - A site page is the CEO's: a manager sees nothing; versions and stats come back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { promoRoutes } = await import('../src/modules/promos/routes.js')
const { discountRoutes } = await import('../src/modules/discounts/routes.js')
const { qrCodeRoutes } = await import('../src/modules/qrcodes/routes.js')
const { loyaltyRoutes } = await import('../src/modules/loyalty/routes.js')
const { calendarRoutes } = await import('../src/modules/calendar/routes.js')
const { mediaRoutes } = await import('../src/modules/media/routes.js')
const { siteLayoutRoutes } = await import('../src/modules/siteLayouts/routes.js')
const { storefrontRoutes } = await import('../src/modules/storefront/routes.js')
const { evaluatePromo } = await import('../src/lib/promoEval.js')

const P = `trk${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
const C = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@trk.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const auth = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const call = (key: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { ...auth(key), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
const json = (r: { json(): unknown }) => r.json() as any // eslint-disable-line @typescript-eslint/no-explicit-any
const entryOf = (type: string, id: string) =>
  prisma.trashEntry.findFirst({ where: { entityType: type, entityId: id }, orderBy: { createdAt: 'desc' } })
const reason = encodeURIComponent('cleaning up old test data')

const WINDOW = { startAt: new Date(Date.now() - 86_400_000).toISOString(), endAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }
const mkPromo = (co: 'A' | 'B', code: string, extra: Record<string, unknown> = {}) =>
  prisma.promoCode.create({
    data: {
      tenantId: T[co], code, discountType: 'percentage', discountValue: 10,
      startAt: new Date(WINDOW.startAt), endAt: new Date(WINDOW.endAt), ...extra,
    },
  })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} Diner A`, slug: `${P}-da`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} Diner B`, slug: `${P}-db`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceo', 'admin', T.A)
  await mkUser('ceoB', 'admin', T.B)
  await mkUser('ownerA', 'owner', T.A)
  await mkUser('ownerB', 'owner', T.B)
  await mkUser('mktA', 'marketing', T.A)
  await mkUser('cashierA', 'cashier', T.A)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(promoRoutes, { prefix: '/promos' })
    await api.register(discountRoutes, { prefix: '/discounts' })
    await api.register(qrCodeRoutes, { prefix: '/qrcodes' })
    await api.register(loyaltyRoutes, { prefix: '/loyalty' })
    await api.register(calendarRoutes, { prefix: '/calendar' })
    await api.register(mediaRoutes, { prefix: '/media' })
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
    await api.register(storefrontRoutes, { prefix: '/storefront' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('promo codes', () => {
  it('a trashed promo is NOT redeemable; company B sees and restores nothing of it', async () => {
    const code = `T${Date.now() % 100000}`.toUpperCase()
    const promo = await mkPromo('A', code)
    const input = { code, tenantId: T.A, conceptId: C.A, foodSubtotalCents: 100_000 }
    expect((await evaluatePromo(input)).ok).toBe(true)

    expect((await call('ownerB', 'DELETE', `/promos/${promo.id}`)).statusCode).toBe(404)
    expect((await evaluatePromo(input)).ok).toBe(true)

    expect((await call('mktA', 'DELETE', `/promos/${promo.id}?reason=old%20offer`)).statusCode).toBe(204)
    const row = (await prisma.promoCode.findUnique({ where: { id: promo.id } }))!
    expect(row.deletedAt).not.toBeNull()
    expect(row.isActive).toBe(false)
    const e = (await entryOf('promo_code', promo.id))!
    expect(e.tenantId).toBe(T.A)
    expect(e.reason).toBe('old offer')
    expect((await evaluatePromo(input)).ok).toBe(false)

    // gone from the live list, shown in the Trash for company A only
    expect(json(await call('ownerA', 'GET', '/promos')).map((p: { id: string }) => p.id)).not.toContain(promo.id)
    expect(json(await call('ownerA', 'GET', '/trash?type=promo_code')).items.map((i: { id: string }) => i.id)).toContain(promo.id)
    expect(json(await call('ownerB', 'GET', '/trash?type=promo_code')).items.map((i: { id: string }) => i.id)).not.toContain(promo.id)
    expect((await call('ownerB', 'POST', `/trash/promo_code/${promo.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('cashierA', 'POST', `/trash/promo_code/${promo.id}/restore`, {})).statusCode).toBe(404)
    // an edit of a trashed code is a 404, not a way to switch it back on
    expect((await call('ownerA', 'PATCH', `/promos/${promo.id}`, { isActive: true })).statusCode).toBe(404)

    expect((await call('ownerA', 'POST', `/trash/promo_code/${promo.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.promoCode.findUnique({ where: { id: promo.id } }))!.deletedAt).toBeNull()
    expect((await evaluatePromo(input)).ok).toBe(true) // back to the on state it had
  })

  it('re-creating the code while the old one is trashed, then restoring -> TRASH_CLASH with a suggestion', async () => {
    const code = `SAME${Date.now() % 100000}`
    const old = await mkPromo('A', code)
    expect((await call('ownerA', 'DELETE', `/promos/${old.id}`)).statusCode).toBe(204)

    const created = await call('ownerA', 'POST', '/promos', { code, discountValue: 15, ...WINDOW })
    expect(created.statusCode).toBe(201) // a trashed code does not block a new one
    expect((await call('ownerA', 'POST', '/promos', { code, discountValue: 15, ...WINDOW })).statusCode).toBe(409) // a live one does

    const clash = await call('ownerA', 'POST', `/trash/promo_code/${old.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(json(clash).error.code).toBe('TRASH_CLASH')
    expect(json(clash).error.details).toMatchObject({ field: 'code', renamable: true, suggestion: `${code}-2` })

    const ok = await call('ownerA', 'POST', `/trash/promo_code/${old.id}/restore`, { rename: { code: `${code}-2` } })
    expect(ok.statusCode).toBe(200)
    expect((await prisma.promoCode.findUnique({ where: { id: old.id } }))!.code).toBe(`${code}-2`)
  })

  it('another company may hold the same code text; a used promo is not erasable, an unused one is (CEO only)', async () => {
    const code = `USED${Date.now() % 100000}`
    await mkPromo('B', code) // company B's own — never a clash for A
    const used = await mkPromo('A', code)
    const order = await prisma.order.create({ data: { conceptId: C.A, source: 'pos', totalCents: 50_000, promoCodeId: used.id } })
    await prisma.promoCodeUsage.create({ data: { promoCodeId: used.id, orderId: order.id, discountCents: 1000 } })
    const unused = await mkPromo('A', `${code}X`)
    await call('ownerA', 'DELETE', `/promos/${used.id}`)
    await call('ownerA', 'DELETE', `/promos/${unused.id}`)

    expect((await call('ownerA', 'DELETE', `/trash/promo_code/${unused.id}?reason=${reason}`)).statusCode).toBe(403)
    expect((await call('ceoB', 'DELETE', `/trash/promo_code/${unused.id}?reason=${reason}`)).statusCode).toBe(404)
    const inUse = await call('ceo', 'DELETE', `/trash/promo_code/${used.id}?reason=${reason}`)
    expect(inUse.statusCode).toBe(409)
    expect(json(inUse).error.code).toBe('IN_USE')
    expect((await prisma.promoCode.findUnique({ where: { id: used.id } }))).not.toBeNull()
    expect((await call('ceo', 'DELETE', `/trash/promo_code/${unused.id}?reason=${reason}`)).statusCode).toBe(204)
    expect(await prisma.promoCode.findUnique({ where: { id: unused.id } })).toBeNull()
  })
})

describe('section discounts, QR codes, tiers, media, storefront promos', () => {
  it('discount: snapshot round trip, company B 404, category in the Trash blocks the restore', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Desserts` } })
    const d = await prisma.sectionDiscount.create({
      data: {
        conceptId: C.A, categoryId: cat.id, discountPercent: 20, deliveryTypes: ['all'], orderTypes: ['all'],
        startDate: new Date(), endDate: new Date(Date.now() + 86_400_000), startTime: '10:00', endTime: '22:00',
      },
    })
    expect((await call('ownerB', 'DELETE', `/discounts/sections/${d.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/discounts/sections/${d.id}`)).statusCode).toBe(204)
    expect(await prisma.sectionDiscount.findUnique({ where: { id: d.id } })).toBeNull()
    const e = (await entryOf('discount', d.id))!
    expect(e.tenantId).toBe(T.A)
    expect(e.conceptId).toBe(C.A)
    expect((await call('ownerB', 'POST', `/trash/discount/${d.id}/restore`, {})).statusCode).toBe(404)

    await prisma.category.update({ where: { id: cat.id }, data: { deletedAt: new Date() } })
    const blocked = await call('ownerA', 'POST', `/trash/discount/${d.id}/restore`, {})
    expect(blocked.statusCode).toBe(409)
    expect(json(blocked).error.code).toBe('PARENT_IN_TRASH')
    await prisma.category.update({ where: { id: cat.id }, data: { deletedAt: null } })

    expect((await call('ownerA', 'POST', `/trash/discount/${d.id}/restore`, {})).statusCode).toBe(200)
    const back = (await prisma.sectionDiscount.findUnique({ where: { id: d.id } }))!
    expect(back.discountPercent).toBe(20)
    expect(back.categoryId).toBe(cat.id)
  })

  it('QR code comes back under the same id; a deleted table is dropped from it', async () => {
    const table = await prisma.table.create({ data: { conceptId: C.A, label: `${P}-t1`, capacity: 4 } as never })
    const qr = await prisma.qrCode.create({ data: { conceptId: C.A, tableId: table.id, label: `${P} Table 1`, scanCount: 7 } })
    expect((await call('ownerB', 'DELETE', `/qrcodes/${qr.id}`)).statusCode).toBe(404)
    expect((await call('mktA', 'DELETE', `/qrcodes/${qr.id}`)).statusCode).toBe(204)
    expect((await entryOf('qr_code', qr.id))!.tenantId).toBe(T.A)
    await prisma.table.update({ where: { id: table.id }, data: { deletedAt: new Date() } })
    expect((await call('ownerB', 'POST', `/trash/qr_code/${qr.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('mktA', 'POST', `/trash/qr_code/${qr.id}/restore`, {})).statusCode).toBe(200)
    const back = (await prisma.qrCode.findUnique({ where: { id: qr.id } }))!
    expect(back.scanCount).toBe(7)
    expect(back.tableId).toBeNull()
  })

  it('loyalty tier: restore clashes when the slug was re-created', async () => {
    const a = await prisma.tierConfig.create({ data: { tenantId: T.A, tier: `gold-${P}`, rank: 3 } })
    await prisma.tierConfig.create({ data: { tenantId: T.B, tier: `gold-${P}`, rank: 3 } }) // B's own ladder
    expect((await call('ownerB', 'DELETE', `/loyalty/tiers/${a.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/loyalty/tiers/${a.id}`)).statusCode).toBe(204)
    expect(await prisma.tierConfig.findUnique({ where: { id: a.id } })).toBeNull()
    await prisma.tierConfig.create({ data: { tenantId: T.A, tier: `gold-${P}`, rank: 1 } })
    const clash = await call('ownerA', 'POST', `/trash/tier_config/${a.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(json(clash).error.code).toBe('TRASH_CLASH')
    await prisma.tierConfig.deleteMany({ where: { tenantId: T.A, tier: `gold-${P}` } })
    expect((await call('ownerA', 'POST', `/trash/tier_config/${a.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.tierConfig.findUnique({ where: { id: a.id } }))!.rank).toBe(3)
  })

  it('media asset: managers restore their own company\'s file; B gets 404', async () => {
    const m = await prisma.mediaAsset.create({
      data: { tenantId: T.A, key: `${P}/x.png`, url: `https://cdn.example/${P}/x.png`, filename: 'x.png', contentType: 'image/png', name: `${P} Logo`, tags: ['a'] },
    })
    expect((await call('ownerB', 'DELETE', `/media/${m.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/media/${m.id}`)).statusCode).toBe(204)
    expect((await entryOf('media_asset', m.id))!.tenantId).toBe(T.A)
    expect((await call('ownerB', 'POST', `/trash/media_asset/${m.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'POST', `/trash/media_asset/${m.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.mediaAsset.findUnique({ where: { id: m.id } }))!.tags).toEqual(['a'])
  })

  it('storefront promo card: snapshot and restore, company-stamped', async () => {
    const p = await prisma.storefrontPromo.create({ data: { tenantId: T.A, badge: 'NEW', headline: `${P} Deal`, sub: 'two for one' } })
    expect((await call('ownerB', 'DELETE', `/storefront/admin/promos/${p.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/storefront/admin/promos/${p.id}`)).statusCode).toBe(204)
    expect((await entryOf('storefront_promo', p.id))!.tenantId).toBe(T.A)
    expect((await call('ownerB', 'POST', `/trash/storefront_promo/${p.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'POST', `/trash/storefront_promo/${p.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.storefrontPromo.findUnique({ where: { id: p.id } }))!.headline).toBe(`${P} Deal`)
  })
})

describe('calendar events', () => {
  it('an event comes back with its social post, which is never auto-published', async () => {
    const ev = await prisma.contentEvent.create({
      data: {
        tenantId: T.A, title: `${P} Eid post`, type: 'social_post', startDate: new Date(), status: 'scheduled',
        createdById: U.ownerA!.id,
      },
    })
    await prisma.socialPost.create({
      data: { eventId: ev.id, platform: 'instagram', caption: 'Eid Mubarak', scheduledFor: new Date(Date.now() - 3600_000), status: 'scheduled' },
    })
    expect((await call('ownerB', 'DELETE', `/calendar/${ev.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/calendar/${ev.id}`)).statusCode).toBe(204)
    expect(await prisma.contentEvent.findUnique({ where: { id: ev.id } })).toBeNull()
    expect(await prisma.socialPost.findUnique({ where: { eventId: ev.id } })).toBeNull()
    expect((await entryOf('content_event', ev.id))!.tenantId).toBe(T.A)
    expect((await call('ownerB', 'POST', `/trash/content_event/${ev.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('mktA', 'POST', `/trash/content_event/${ev.id}/restore`, {})).statusCode).toBe(404) // calendar is the managers': the type is invisible to marketing

    expect((await call('ownerA', 'POST', `/trash/content_event/${ev.id}/restore`, {})).statusCode).toBe(200)
    const post = (await prisma.socialPost.findUnique({ where: { eventId: ev.id } }))!
    expect(post.caption).toBe('Eid Mubarak')
    expect(post.status).toBe('draft') // its time had passed: not published by a restore
    expect((await prisma.contentEvent.findUnique({ where: { id: ev.id } }))!.status).toBe('draft')
  })
})

describe('site pages', () => {
  it('a manager never sees a page in the Trash; the CEO restores it with its versions and stats', async () => {
    const slug = `page:${P}`
    const row = await prisma.siteLayout.create({
      data: { slug, title: `${P} About`, kind: 'page', tenantId: null, blocks: [{ type: 'text' }], liveVersion: 2 },
    })
    await prisma.siteLayoutVersion.createMany({
      data: [{ layoutId: row.id, version: 1, blocks: [] }, { layoutId: row.id, version: 2, blocks: [{ type: 'text' }] }],
    })
    await prisma.siteLayoutStat.create({ data: { layoutId: row.id, version: 2, variant: 'a', views: 40, conversions: 3 } })

    expect((await call('ownerA', 'DELETE', `/site-layouts/${slug}`)).statusCode).toBe(403)
    expect((await call('ceo', 'DELETE', `/site-layouts/${slug}`)).statusCode).toBe(204)
    expect(await prisma.siteLayout.findUnique({ where: { id: row.id } })).toBeNull()
    const e = (await entryOf('site_layout', row.id))!
    expect(e.tenantId).toBeNull() // shared page: deliberately company-less

    expect(json(await call('ownerA', 'GET', '/trash?type=site_layout')).items ?? []).toHaveLength(0)
    expect((await call('ownerA', 'POST', `/trash/site_layout/${row.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('mktA', 'POST', `/trash/site_layout/${row.id}/restore`, {})).statusCode).toBe(404)

    // a new page at the same address blocks the restore; a page: slug can be renamed
    await prisma.siteLayout.create({ data: { slug, kind: 'page', blocks: [], liveVersion: 0 } })
    const clash = await call('ceo', 'POST', `/trash/site_layout/${row.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(json(clash).error.details).toMatchObject({ field: 'slug', renamable: true })
    await prisma.siteLayout.delete({ where: { slug } })

    expect((await call('ceo', 'POST', `/trash/site_layout/${row.id}/restore`, {})).statusCode).toBe(200)
    const back = (await prisma.siteLayout.findUnique({ where: { id: row.id } }))!
    expect(back.liveVersion).toBe(2)
    expect(await prisma.siteLayoutVersion.count({ where: { layoutId: row.id } })).toBe(2)
    expect((await prisma.siteLayoutStat.findFirst({ where: { layoutId: row.id } }))!.views).toBe(40)
  })

  it('a company page is the CEO of THAT company only; a discarded never-published draft goes to the Trash', async () => {
    const slug = `brand:${P}-da:about2`
    const row = await prisma.siteLayout.create({
      data: { slug, title: `${P} A page`, kind: 'page', tenantId: T.A, blocks: [], liveVersion: 0, draftBlocks: [{ type: 'text' }], draftStatus: 'draft' },
    })
    expect((await call('ceoB', 'DELETE', `/site-layouts/${slug}/draft`)).statusCode).toBe(404)
    expect((await call('ceo', 'DELETE', `/site-layouts/${slug}/draft`)).statusCode).toBe(204)
    expect(await prisma.siteLayout.findUnique({ where: { id: row.id } })).toBeNull()
    const e = (await entryOf('site_layout', row.id))!
    expect(e.tenantId).toBe(T.A)
    expect((await call('ceoB', 'POST', `/trash/site_layout/${row.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ceo', 'POST', `/trash/site_layout/${row.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.siteLayout.findUnique({ where: { id: row.id } }))!.draftStatus).toBe('draft')
  })
})
