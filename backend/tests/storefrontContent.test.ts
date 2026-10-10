// Storefront content module (decision 41): drafts, CEO approval, scheduled
// publishing, rollback, company scoping, pop-up windows, A/B counters, the
// SEO settings and the public live-pages list the sitemap reads.
//
// Drives the real route handlers through Fastify inject against the
// disposable test database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { siteLayoutRoutes } = await import('../src/modules/siteLayouts/routes.js')
const { publishDueLayouts, parseSlug } = await import('../src/modules/siteLayouts/service.js')
const { blocksSchema, pageSettingsSchema } = await import('../src/modules/siteLayouts/schemas.js')

const PREFIX = 'sfc'
const STAMP = Date.now()
let app: FastifyInstance
let tenantA: string
let tenantB: string
let slugA = ''
let slugB = ''
let slugHidden = ''
type U = { id: string; name: string; email: string; role: string }
let ceo: U
let marketer: U
let marketerB: U
let cashier: U
const userIds: string[] = []

async function makeUser(label: string, role: string, primary: string, memberOf: string[]): Promise<U> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${label}`,
      email: `${PREFIX}.${label}.${STAMP}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: role as never,
      tenantId: primary,
      isActive: true,
      accountStatus: 'active',
      tenantMemberships: { create: memberOf.map((t) => ({ tenant: { connect: { id: t } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  userIds.push(u.id)
  return u as U
}

function auth(u: U) {
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/site-layouts${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })

const enc = (s: string) => encodeURIComponent(s)
const blocks = (label: string) => [{ id: `b-${label}`, type: 'text', body: label }]

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SFC Co A', slug: `${PREFIX}-a-${STAMP}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SFC Co B', slug: `${PREFIX}-b-${STAMP}` } })).id
  slugA = `${PREFIX}-brand-a-${STAMP}`
  slugB = `${PREFIX}-brand-b-${STAMP}`
  await prisma.concept.create({ data: { name: 'SFC Brand A', slug: slugA, type: 'restaurant', tenantId: tenantA } })
  await prisma.concept.create({ data: { name: 'SFC Brand B', slug: slugB, type: 'restaurant', tenantId: tenantB } })
  slugHidden = `${PREFIX}-brand-hidden-${STAMP}`
  await prisma.concept.create({ data: { name: 'SFC Brand Hidden', slug: slugHidden, type: 'restaurant', tenantId: tenantA, storefrontVisible: false } })
  ceo = await makeUser('ceo', 'admin', tenantA, [tenantA, tenantB])
  marketer = await makeUser('mkt', 'marketing', tenantA, [tenantA])
  marketerB = await makeUser('mktb', 'marketing', tenantB, [tenantB])
  cashier = await makeUser('cash', 'cashier', tenantA, [tenantA])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', details: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[storefrontContent] 500:', err)
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await prisma.siteLayout.deleteMany({
    where: { OR: [{ slug: { contains: `${PREFIX}-` } }, { tenantId: { in: [tenantA, tenantB] } }] },
  })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.concept.deleteMany({ where: { slug: { in: [slugA, slugB, slugHidden] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('draft → submit → approve', () => {
  const slug = () => `brand:${slugA}`

  it('public read of a slug with no row is the null skeleton', async () => {
    const r = await call('GET', `/${enc(slug())}`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ slug: slug(), blocks: null, version: 0, fonts: [] })
  })

  it('a role without the storefront module cannot draft', async () => {
    const r = await call('PUT', `/${enc(slug())}/draft`, auth(cashier), { blocks: blocks('x') })
    expect(r.statusCode).toBe(403)
  })

  it('rejects bad block JSON', async () => {
    const nested = [{ id: 'c', type: 'columns', columns: [[{ id: 'i', type: 'columns', columns: [[], []] }], []] }]
    expect((await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: nested })).statusCode).toBe(400)
    expect((await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: [{ id: 'z', type: 'nope' }] })).statusCode).toBe(400)
  })

  it('draft, submit, non-admin approve is 403, admin approve publishes v1 then v2', async () => {
    let r = await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: blocks('v1'), settings: { fonts: { heading: 'Brandy' } } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ draftStatus: 'draft', tenantId: tenantA, liveVersion: 0 })

    // Not live yet.
    expect((await call('GET', `/${enc(slug())}`)).json().blocks).toBeNull()

    r = await call('POST', `/${enc(slug())}/submit`, auth(marketer))
    expect(r.json().draftStatus).toBe('pending')
    expect((await call('GET', '/?status=pending', auth(marketer))).json().map((x: { slug: string }) => x.slug)).toContain(slug())

    expect((await call('POST', `/${enc(slug())}/approve`, auth(marketer), {})).statusCode).toBe(403)

    r = await call('POST', `/${enc(slug())}/approve`, auth(ceo), {})
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ liveVersion: 1, draftStatus: 'none', draftBlocks: null })

    const pub = (await call('GET', `/${enc(slug())}`)).json()
    expect(pub.version).toBe(1)
    expect(pub.blocks).toEqual(blocks('v1'))

    await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: blocks('v2') })
    await call('POST', `/${enc(slug())}/submit`, auth(marketer))
    r = await call('POST', `/${enc(slug())}/approve`, auth(ceo), {})
    expect(r.json().liveVersion).toBe(2)
    expect((await call('GET', `/${enc(slug())}`)).json().blocks).toEqual(blocks('v2'))

    const versions = (await call('GET', `/${enc(slug())}/versions`, auth(marketer))).json()
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1])
    expect(versions[0].publishedBy.id).toBe(marketer.id)
    expect(versions[0].approvedBy.id).toBe(ceo.id)
  })

  it('reject sends the draft back with a note', async () => {
    await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: blocks('bad') })
    await call('POST', `/${enc(slug())}/submit`, auth(marketer))
    const r = await call('POST', `/${enc(slug())}/reject`, auth(ceo), { note: 'Too loud' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ draftStatus: 'draft', reviewNote: 'Too loud' })
    expect((await call('GET', `/${enc(slug())}`)).json().blocks).toEqual(blocks('v2'))
  })

  it('rollback republishes an old version as a new version', async () => {
    const r = await call('POST', `/${enc(slug())}/rollback`, auth(ceo), { version: 1 })
    expect(r.statusCode).toBe(200)
    expect(r.json().liveVersion).toBe(3)
    const pub = (await call('GET', `/${enc(slug())}`)).json()
    expect(pub.version).toBe(3)
    expect(pub.blocks).toEqual(blocks('v1'))
    expect((await call('POST', `/${enc(slug())}/rollback`, auth(marketer), { version: 1 })).statusCode).toBe(403)
  })

  it('a scheduled publish with a past publishAt goes live on the public read, exactly once', async () => {
    await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: blocks('scheduled') })
    await call('POST', `/${enc(slug())}/submit`, auth(marketer))
    const future = new Date(Date.now() + 3_600_000).toISOString()
    let r = await call('POST', `/${enc(slug())}/approve`, auth(ceo), { publishAt: future })
    expect(r.json()).toMatchObject({ draftStatus: 'scheduled', liveVersion: 3 })
    expect((await call('GET', `/${enc(slug())}`)).json().version).toBe(3)

    // Time passes.
    await prisma.siteLayout.update({ where: { slug: slug() }, data: { publishAt: new Date(Date.now() - 1000) } })
    const [a, b] = await Promise.all([call('GET', `/${enc(slug())}`), publishDueLayouts()])
    expect(a.json().version).toBe(4)
    expect(a.json().blocks).toEqual(blocks('scheduled'))
    expect(b).toBeLessThanOrEqual(1)
    const count = await prisma.siteLayoutVersion.count({ where: { layout: { slug: slug() } } })
    expect(count).toBe(4)
    r = await call('GET', `/${enc(slug())}/edit`, auth(marketer))
    expect(r.json()).toMatchObject({ draftStatus: 'none', liveVersion: 4 })
  })

  it('a preview token returns the draft and is not an access token', async () => {
    await call('PUT', `/${enc(slug())}/draft`, auth(marketer), { blocks: blocks('preview') })
    const { token } = (await call('POST', `/${enc(slug())}/preview-token`, auth(marketer), {})).json()
    const prev = await call('GET', `/preview/${token}`)
    expect(prev.statusCode).toBe(200)
    expect(prev.json().blocks).toEqual(blocks('preview'))
    // The same token must not authenticate a staff route.
    expect((await call('GET', '/', { authorization: `Bearer ${token}` })).statusCode).toBe(401)
  })
})

describe('sections and page kinds', () => {
  it('saves section blocks (and the waitlist form) on a brand page', async () => {
    const blocksIn = [
      { id: 's1', type: 'section', variant: 'stackd.hero', fields: { headline: 'Cooked here.', cta: { text: 'Order', href: '/stackd' } } },
      { id: 's2', type: 'section', variant: 'brand.footer' },
      { id: 'w', type: 'waitlist_form' },
    ]
    const r = await call('PUT', `/${enc(`brand:${slugA}:footer`)}/draft`, auth(marketer), { blocks: blocksIn })
    expect(r.statusCode).toBe(200)
    expect(r.json().draftBlocks).toEqual(blocksIn)
  })

  it('rejects a section without a well-formed variant, and the retired one-off types', () => {
    const ok = (b: Record<string, unknown>) => blocksSchema.safeParse([{ id: 'x', ...b }]).success
    expect(ok({ type: 'section', variant: 'servd.nav', fields: {} })).toBe(true)
    expect(ok({ type: 'section' })).toBe(false)
    expect(ok({ type: 'section', variant: 'no-group' })).toBe(false)
    expect(ok({ type: 'section', variant: 'x.y', fields: 'nope' })).toBe(false)
    for (const type of ['scrollHero', 'brandFooter', 'siteLogo', 'signature']) expect(ok({ type }), type).toBe(false)
  })

  it('header/footer slugs are the chrome kinds; servd:feedback is a widget; other brand sub-pages are pages', () => {
    expect(parseSlug('servd:header')).toEqual({ owner: 'shared', kind: 'header' })
    expect(parseSlug('servd:footer')).toEqual({ owner: 'shared', kind: 'footer' })
    expect(parseSlug('servd:feedback')).toEqual({ owner: 'shared', kind: 'widget' })
    // Only servd's: a brand page called "feedback" is a page the owner added.
    expect(parseSlug('brand:stackd:feedback')).toEqual({ owner: 'brand', kind: 'page', conceptSlug: 'stackd' })
    expect(parseSlug('brand:stackd:header')).toEqual({ owner: 'brand', kind: 'header', conceptSlug: 'stackd' })
    expect(parseSlug('brand:stackd:about')).toEqual({ owner: 'brand', kind: 'page', conceptSlug: 'stackd' })
    expect(parseSlug('brand:stackd:ramadan')).toEqual({ owner: 'brand', kind: 'page', conceptSlug: 'stackd' })
  })

  it("a custom page on another company's brand is 404 for the editor", async () => {
    const r = await call('PUT', `/${enc(`brand:${slugA}:ramadan`)}/draft`, auth(marketerB), { blocks: [{ id: 's', type: 'section', variant: 'brand.header' }] })
    expect(r.statusCode).toBe(404)
  })
})

describe('company scoping', () => {
  it("another company's brand page is 404", async () => {
    const slug = enc(`brand:${slugA}`)
    expect((await call('GET', `/${slug}/edit`, auth(marketerB))).statusCode).toBe(404)
    expect((await call('PUT', `/${slug}/draft`, auth(marketerB), { blocks: blocks('evil') })).statusCode).toBe(404)
    expect((await call('GET', `/${enc(`brand:${slugB}`)}/edit`, auth(marketer))).statusCode).toBe(404)
    const list = (await call('GET', '/', auth(marketerB))).json()
    expect(list.map((x: { slug: string }) => x.slug)).not.toContain(`brand:${slugA}`)
  })

  it('a pop-up targeting brands of two companies is 422', async () => {
    const rules = { popupKind: 'offer', display: 'modal', trigger: 'before_page', pages: [], brands: [slugA, slugB], audience: 'everyone', frequency: 'once' }
    const r = await call('PUT', `/${enc(`popup:${PREFIX}-mixed-${STAMP}`)}/draft`, auth(ceo), { blocks: blocks('p'), settings: { popup: rules } })
    expect(r.statusCode).toBe(422)
  })
})

describe('pop-ups and tracking', () => {
  const rules = (extra: Record<string, unknown>) => ({
    popupKind: 'announcement', display: 'bar', trigger: 'before_page', pages: ['/'], brands: [],
    audience: 'everyone', frequency: 'daily', ...extra,
  })
  const livePopup = `popup:${PREFIX}-live-${STAMP}`
  const futurePopup = `popup:${PREFIX}-future-${STAMP}`
  const pastPopup = `popup:${PREFIX}-past-${STAMP}`

  beforeAll(async () => {
    const hour = 3_600_000
    const cases: Array<[string, Record<string, unknown>]> = [
      [livePopup, { startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + hour).toISOString() }],
      [futurePopup, { startsAt: new Date(Date.now() + hour).toISOString() }],
      [pastPopup, { endsAt: new Date(Date.now() - hour).toISOString() }],
    ]
    for (const [slug, window] of cases) {
      const r = await call('PUT', `/${enc(slug)}/draft`, auth(marketer), { blocks: blocks(slug), settings: { popup: rules(window) } })
      expect(r.statusCode).toBe(200)
      expect(r.json().tenantId).toBeNull()
      expect((await call('POST', `/${enc(slug)}/approve`, auth(ceo), {})).statusCode).toBe(200)
    }
  })

  it('popups/live returns only pop-ups inside their window', async () => {
    const r = await call('GET', '/popups/live')
    expect(r.statusCode).toBe(200)
    const slugs = r.json().map((p: { slug: string }) => p.slug)
    expect(slugs).toContain(livePopup)
    expect(slugs).not.toContain(futurePopup)
    expect(slugs).not.toContain(pastPopup)
    const live = r.json().find((p: { slug: string }) => p.slug === livePopup)
    expect(live).toMatchObject({ version: 1, rules: { display: 'bar' } })
  })

  it('track increments views/conversions and ignores unknown slugs and versions', async () => {
    const t = (slug: string, body: unknown) => call('POST', `/${enc(slug)}/track`, {}, body)
    expect((await t(livePopup, { version: 1, variant: 'a', event: 'view' })).statusCode).toBe(204)
    await t(livePopup, { version: 1, variant: 'a', event: 'view' })
    await t(livePopup, { version: 1, variant: 'a', event: 'convert' })
    await t(livePopup, { version: 1, variant: 'b', event: 'view' })
    expect((await t(livePopup, { version: 9, variant: 'a', event: 'view' })).statusCode).toBe(204)
    expect((await t(`popup:${PREFIX}-nope`, { version: 1, variant: 'a', event: 'view' })).statusCode).toBe(204)

    const stats = (await call('GET', `/${enc(livePopup)}/stats`, auth(marketer))).json()
    expect(stats).toEqual([
      { version: 1, variant: 'a', views: 2, conversions: 1 },
      { version: 1, variant: 'b', views: 1, conversions: 0 },
    ])
  })
})

describe('page SEO settings', () => {
  it('accepts a trimmed, bounded settings.seo and rejects unknown keys and over-long text', () => {
    const parsed = pageSettingsSchema.parse({ seo: { title: '  Ramadan at Stackd  ', description: ' Iftar boxes. ' } })
    expect(parsed.seo).toEqual({ title: 'Ramadan at Stackd', description: 'Iftar boxes.' })
    expect(pageSettingsSchema.safeParse({ seo: {} }).success).toBe(true)
    expect(pageSettingsSchema.safeParse({ seo: { title: 'x'.repeat(121) } }).success).toBe(false)
    expect(pageSettingsSchema.safeParse({ seo: { description: 'x'.repeat(301) } }).success).toBe(false)
    expect(pageSettingsSchema.safeParse({ seo: { keywords: 'x' } }).success).toBe(false)
    expect(pageSettingsSchema.safeParse({ seo: { title: 5 } }).success).toBe(false)
  })
})

describe('pages/live (the sitemap list)', () => {
  const SECRET = `BLOCK-CONTENT-${STAMP}`
  const SEO_SECRET = `SEO-TITLE-${STAMP}`
  const body = [{ id: 'b', type: 'text', body: SECRET }]
  const live = `page:${PREFIX}-pl-live-${STAMP}`
  const draftOnly = `page:${PREFIX}-pl-draft-${STAMP}`
  const pending = `page:${PREFIX}-pl-pending-${STAMP}`
  const scheduled = `page:${PREFIX}-pl-sched-${STAMP}`
  const due = `page:${PREFIX}-pl-due-${STAMP}`
  const popup = `popup:${PREFIX}-pl-popup-${STAMP}`
  const brandPageA = () => `brand:${slugA}:pl-${STAMP}`
  const brandPageB = () => `brand:${slugB}:pl-${STAMP}`
  const hiddenBrandPage = () => `brand:${slugHidden}:pl-${STAMP}`
  const footerA = () => `brand:${slugA}:footer`
  const legacyHeaderA = () => `brand:${slugA}:header`
  // Cleared and approved: an owner page with nothing live is a 404 on the
  // storefront; a built-in page falls back to its default design.
  const emptyPage = `page:${PREFIX}-pl-empty-${STAMP}`
  const emptyBrandPageA = () => `brand:${slugA}:pl-empty-${STAMP}`
  const emptyAboutA = () => `brand:${slugA}:about`
  // A reserved brand part in another case is not the built-in page or the
  // chrome, and the storefront has no URL for it.
  const casedAboutA = () => `brand:${slugA}:About`
  const casedHeaderA = () => `brand:${slugA}:Header`
  // The feedback button is a widget, not a page. servd:feedback is one global
  // row (no company, no test prefix), so it is only written when the test
  // database has none, and removed again below.
  const widget = 'servd:feedback'
  let widgetCreated = false

  const draft = async (slug: string, who: U, settings?: Record<string, unknown>, content: unknown[] = body) => {
    const r = await call('PUT', `/${enc(slug)}/draft`, auth(who), { blocks: content, ...(settings ? { settings } : {}) })
    expect(r.statusCode, slug).toBe(200)
  }
  const approve = async (slug: string, publishAt?: string) => {
    const r = await call('POST', `/${enc(slug)}/approve`, auth(ceo), publishAt ? { publishAt } : {})
    expect(r.statusCode, slug).toBe(200)
    return r.json()
  }
  const list = async () => {
    const r = await call('GET', '/pages/live')
    expect(r.statusCode).toBe(200)
    return r.json() as Array<Record<string, unknown>>
  }

  beforeAll(async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()

    // Live, with a newer draft on top that must not show.
    await draft(live, marketer, { seo: { title: SEO_SECRET } })
    await approve(live)
    await draft(live, marketer, { seo: { title: `${SEO_SECRET}-draft` } })

    await draft(draftOnly, marketer)
    await draft(pending, marketer)
    expect((await call('POST', `/${enc(pending)}/submit`, auth(marketer))).statusCode).toBe(200)
    await draft(scheduled, marketer)
    expect((await approve(scheduled, future)).draftStatus).toBe('scheduled')
    await draft(due, marketer)
    await approve(due, future)
    await prisma.siteLayout.update({ where: { slug: due }, data: { publishAt: new Date(Date.now() - 1000) } })

    // Owner pages of two companies, and one of a brand hidden from the storefront.
    await draft(brandPageA(), marketer)
    await approve(brandPageA())
    await draft(brandPageB(), marketerB)
    await approve(brandPageB())
    await draft(hiddenBrandPage(), marketer)
    await approve(hiddenBrandPage())

    // Chrome and pop-ups are not pages: a published footer, a header row
    // from before the kind column (stored kind 'page'), and a live pop-up.
    await draft(footerA(), marketer)
    await approve(footerA())
    await prisma.siteLayout.upsert({
      where: { slug: legacyHeaderA() },
      create: { slug: legacyHeaderA(), kind: 'page', tenantId: tenantA, blocks: body, liveVersion: 1, publishedAt: new Date() },
      update: { kind: 'page', blocks: body, liveVersion: 1, publishedAt: new Date() },
    })
    const rules = { popupKind: 'announcement', display: 'bar', trigger: 'before_page', pages: [], brands: [], audience: 'everyone', frequency: 'daily' }
    await draft(popup, marketer, { popup: rules })
    await approve(popup)

    for (const slug of [emptyPage, emptyBrandPageA(), emptyAboutA()]) {
      await draft(slug, marketer, undefined, [])
      await approve(slug)
    }
    for (const slug of [casedAboutA(), casedHeaderA()]) {
      await draft(slug, marketer)
      await approve(slug)
    }
    if (!(await prisma.siteLayout.findUnique({ where: { slug: widget } }))) {
      widgetCreated = true
      await draft(widget, marketer, undefined, [{ id: 'f', type: 'section', variant: 'servd.feedback' }])
      await approve(widget)
    }
  })

  afterAll(async () => {
    if (widgetCreated) await prisma.siteLayout.deleteMany({ where: { slug: widget } })
  })

  it('lists published pages — servd custom pages and every company\'s brand pages — with no auth', async () => {
    const slugs = (await list()).map((p) => p.slug)
    expect(slugs).toContain(live)
    expect(slugs).toContain(brandPageA())
    expect(slugs).toContain(brandPageB())
  })

  it('never lists a draft, a pending draft or a scheduled page whose time has not come', async () => {
    const slugs = (await list()).map((p) => p.slug)
    expect(slugs).not.toContain(draftOnly)
    expect(slugs).not.toContain(pending)
    expect(slugs).not.toContain(scheduled)
    const row = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: scheduled } })
    expect(row).toMatchObject({ liveVersion: 0, draftStatus: 'scheduled' })
  })

  it('publishes a scheduled page that has come due, then lists it', async () => {
    const entry = (await list()).find((p) => p.slug === due)
    expect(entry).toBeDefined()
    expect((await prisma.siteLayout.findUniqueOrThrow({ where: { slug: due } })).liveVersion).toBe(1)
  })

  it('leaves out header/footer chrome, pop-ups and pages of a brand hidden from the storefront', async () => {
    const slugs = (await list()).map((p) => p.slug)
    expect(slugs).not.toContain(footerA())
    expect(slugs).not.toContain(legacyHeaderA())
    expect(slugs).not.toContain(popup)
    expect(slugs).not.toContain(hiddenBrandPage())
  })

  it('leaves out the feedback widget (servd:feedback), even when live', async () => {
    if (widgetCreated) {
      expect(await prisma.siteLayout.findUniqueOrThrow({ where: { slug: widget } })).toMatchObject({ kind: 'widget', tenantId: null, liveVersion: 1 })
      const edit = await call('GET', `/${enc(widget)}/edit`, auth(marketer))
      expect(edit.json()).toMatchObject({ kind: 'widget' })
      const widgets = await call('GET', '/?kind=widget', auth(marketer))
      expect(widgets.statusCode).toBe(200)
      expect((widgets.json() as Array<{ slug: string }>).map((r) => r.slug)).toContain(widget)
    }
    expect((await list()).map((p) => p.slug)).not.toContain(widget)
  })

  it('leaves out an owner page whose live copy is empty, but keeps an empty built-in page', async () => {
    const slugs = (await list()).map((p) => p.slug)
    for (const slug of [emptyPage, emptyBrandPageA()]) {
      expect((await prisma.siteLayout.findUniqueOrThrow({ where: { slug } })).liveVersion, slug).toBeGreaterThan(0)
      expect(slugs).not.toContain(slug)
    }
    expect(slugs).toContain(emptyAboutA())
  })

  it('leaves out a reserved brand part written in another case', async () => {
    const slugs = (await list()).map((p) => p.slug)
    expect(slugs).not.toContain(casedAboutA())
    expect(slugs).not.toContain(casedHeaderA())
  })

  it('returns only slug + publishedAt — no blocks, settings or draft content', async () => {
    const r = await call('GET', '/pages/live')
    expect(r.body).not.toContain(SECRET)
    expect(r.body).not.toContain(SEO_SECRET)
    for (const p of r.json() as Array<Record<string, unknown>>) {
      expect(Object.keys(p).sort()).toEqual(['publishedAt', 'slug'])
    }
    const entry = (r.json() as Array<{ slug: string; publishedAt: string }>).find((p) => p.slug === live)!
    const row = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: live } })
    expect(new Date(entry.publishedAt).getTime()).toBe(row.publishedAt!.getTime())
  })

  it('the live read carries the trimmed SEO settings of the live copy, not the draft', async () => {
    const pub = (await call('GET', `/${enc(live)}`)).json()
    expect(pub.settings).toEqual({ seo: { title: SEO_SECRET } })
  })
})
