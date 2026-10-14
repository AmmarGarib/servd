// Brand kit (owner, 2026-10-14): brand:<slug>:kit rows (kind 'kit') hold a
// brand's colours, fonts and images in settings.kit, through the same draft →
// submit → CEO approve / schedule / rollback as a page. Two companies:
// company B never sees or edits company A's kit, a library font must be the
// brand company's own, publishing syncs ONLY the Concept fields the kit sets,
// /kits/live lists only live kits of brands on the storefront, the kit slug is
// never a sitemap page, and a company merge moves kits and the Library.
//
// Drives the real route handlers through Fastify inject against the
// disposable test database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma, prisma: routePrisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { siteLayoutRoutes } = await import('../src/modules/siteLayouts/routes.js')
const { tenantRoutes } = await import('../src/modules/tenants/routes.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { mediaRoutes } = await import('../src/modules/media/routes.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { publishDueLayouts, parseSlug } = await import('../src/modules/siteLayouts/service.js')
const { brandKitSchema } = await import('../src/modules/siteLayouts/schemas.js')

const PREFIX = 'bkt'
const STAMP = Date.now()
let app: FastifyInstance
let tenantA: string
let tenantB: string
let slugA = ''
let slugB = ''
let slugHidden = ''
let fontA = ''
let fontB = ''
type U = { id: string; name: string; email: string; role: string }
let ceo: U
let marketer: U
let marketerB: U
let managerA: U
const userIds: string[] = []
const tenantIds: string[] = []
const conceptSlugs: string[] = []

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
const kitSlug = (brand: string) => `brand:${brand}:kit`
const saveKit = (who: U, brand: string, kit: unknown, blocks: unknown[] = []) =>
  call('PUT', `/${enc(kitSlug(brand))}/draft`, auth(who), { kind: 'kit', blocks, settings: { kit } })

async function concept(slug: string) {
  return prisma.concept.findUniqueOrThrow({ where: { slug }, select: { primaryColor: true, logoUrl: true, wordmarkUrl: true, mascotUrl: true } })
}

async function company(label: string) {
  const id = (await prisma.tenant.create({ data: { name: `BKT ${label}`, slug: `${PREFIX}-${label}-${STAMP}` } })).id
  tenantIds.push(id)
  return id
}
async function brand(label: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const slug = `${PREFIX}-${label}-${STAMP}`
  await prisma.concept.create({ data: { name: `BKT ${label}`, slug, type: 'restaurant', tenantId, ...extra } })
  conceptSlugs.push(slug)
  return slug
}
async function font(tenantId: string, family: string) {
  return (await prisma.mediaAsset.create({
    data: {
      tenantId, kind: 'font', key: `fonts/${family}.woff2`, url: `https://cdn.example.com/fonts/${family}-${STAMP}.woff2`,
      filename: `${family}.woff2`, contentType: 'font/woff2', category: 'marketing', fontFamily: family,
    },
  })).id
}

beforeAll(async () => {
  tenantA = await company('a')
  tenantB = await company('b')
  slugA = await brand('brand-a', tenantA, { primaryColor: '#111111', logoUrl: 'https://cdn.example.com/old-logo.png', wordmarkUrl: '/brand/old-wordmark.png' })
  slugB = await brand('brand-b', tenantB)
  slugHidden = await brand('brand-hidden', tenantA, { storefrontVisible: false })
  fontA = await font(tenantA, 'BktDisplayA')
  fontB = await font(tenantB, 'BktDisplayB')
  ceo = await makeUser('ceo', 'admin', tenantA, [tenantA, tenantB])
  marketer = await makeUser('mkt', 'marketing', tenantA, [tenantA])
  marketerB = await makeUser('mktb', 'marketing', tenantB, [tenantB])
  managerA = await makeUser('mgr', 'owner', tenantA, [tenantA])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', details: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[brandKit] 500:', err)
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
    await api.register(tenantRoutes, { prefix: '/tenants' })
    await api.register(conceptRoutes, { prefix: '/concepts' })
    await api.register(mediaRoutes, { prefix: '/media' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await prisma.siteLayout.deleteMany({
    where: { OR: [{ slug: { contains: `${PREFIX}-` } }, { tenantId: { in: tenantIds } }] },
  })
  await prisma.mediaAsset.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.tenantMember.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { tenantId: { in: tenantIds } }] } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.concept.deleteMany({ where: { slug: { in: conceptSlugs } } })
  await prisma.account.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {})
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {})
})

describe('slug grammar', () => {
  it('brand:<b>:kit is kind kit; other parts are unchanged', () => {
    expect(parseSlug('brand:simmer:kit')).toEqual({ owner: 'brand', kind: 'kit', conceptSlug: 'simmer' })
    expect(parseSlug('brand:simmer:footer')?.kind).toBe('footer')
    expect(parseSlug('brand:simmer:about')?.kind).toBe('page')
    expect(parseSlug('servd:kit')?.kind).toBe('page')
  })
})

describe('validation', () => {
  it('rejects 3-digit hex, rgb() and 8-digit hex colours', async () => {
    expect((await saveKit(marketer, slugA, { v: 1, roles: { accent: '#abc' } })).statusCode).toBe(400)
    expect((await saveKit(marketer, slugA, { v: 1, palette: { green: 'rgb(1,2,3)' } })).statusCode).toBe(400)
    expect((await saveKit(marketer, slugA, { v: 1, palette: { green: '#06392F80' } })).statusCode).toBe(400)
    expect(brandKitSchema.safeParse({ v: 1, palette: { green: '#06392F' } }).success).toBe(true)
  })

  it('is strict: unknown keys, bad palette keys, bad fonts and unsafe images are refused', async () => {
    expect((await saveKit(marketer, slugA, { v: 1, extra: true })).statusCode).toBe(400)
    expect((await saveKit(marketer, slugA, { v: 2 })).statusCode).toBe(400)
    expect((await saveKit(marketer, slugA, { v: 1, roles: { glow: '#000000' } })).statusCode).toBe(400)
    expect((await saveKit(marketer, slugA, { v: 1, palette: { 'Bad Key': '#000000' } })).statusCode).toBe(400)
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, '#000000']))
    expect((await saveKit(marketer, slugA, { v: 1, palette: many })).statusCode).toBe(400)
    expect((await saveKit(marketer, slugA, { v: 1, fonts: { display: 'comic-sans' } })).statusCode).toBe(400)
    for (const src of ['javascript:alert(1)', 'http://cdn.example.com/x.png', '/brand/../etc', '//evil.example/x.png', 'data:image/png;base64,AA', '/other/x.png']) {
      expect((await saveKit(marketer, slugA, { v: 1, images: { logo: src } })).statusCode, src).toBe(400)
    }
    expect((await saveKit(marketer, slugA, { v: 1, images: { logo: `https://cdn.example.com/${'a'.repeat(1000)}.png` } })).statusCode).toBe(400)
    // Other settings keys (fonts/ab/seo) don't ride on a kit.
    const r = await call('PUT', `/${enc(kitSlug(slugA))}/draft`, auth(marketer), { blocks: [], settings: { kit: { v: 1 }, seo: { title: 'x' } } })
    expect(r.statusCode).toBe(400)
  })

  it('a kit has no blocks and needs settings.kit; a page never carries a kit', async () => {
    const withBlocks = await saveKit(marketer, slugA, { v: 1 }, [{ id: 'b', type: 'text', body: 'x' }])
    expect(withBlocks.statusCode).toBe(422)
    expect(withBlocks.json().error.code).toBe('KIT_NO_BLOCKS')
    const noSettings = await call('PUT', `/${enc(kitSlug(slugA))}/draft`, auth(marketer), { blocks: [] })
    expect(noSettings.json().error.code).toBe('KIT_REQUIRED')
    const page = await call('PUT', `/${enc(`brand:${slugA}`)}/draft`, auth(marketer), { blocks: [], settings: { kit: { v: 1 } } })
    expect(page.statusCode).toBe(422)
    expect(page.json().error.code).toBe('KIT_NOT_ALLOWED')
  })

  it('cleared fields are dropped (= today\'s default)', async () => {
    const r = await saveKit(marketer, slugA, { v: 1, palette: { green: '', bone: '#EDE6D3' }, roles: { accent: '', ordering: null }, images: { logo: '' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().draftSettings).toEqual({ kit: { v: 1, palette: { bone: '#EDE6D3' }, roles: {}, images: {} } })
    expect(r.json().kind).toBe('kit')
    expect(r.json().draftBlocks).toEqual([])
    await call('DELETE', `/${enc(kitSlug(slugA))}/draft`, auth(marketer))
  })
})

describe('company separation', () => {
  it('company B cannot read, draft or discard company A\'s kit (404)', async () => {
    expect((await saveKit(marketer, slugA, { v: 1, roles: { accent: '#E94E1B' } })).statusCode).toBe(200)
    expect((await call('GET', `/${enc(kitSlug(slugA))}/edit`, auth(marketerB))).statusCode).toBe(404)
    expect((await saveKit(marketerB, slugA, { v: 1, roles: { accent: '#000000' } })).statusCode).toBe(404)
    expect((await call('POST', `/${enc(kitSlug(slugA))}/submit`, auth(marketerB))).statusCode).toBe(404)
    expect((await call('DELETE', `/${enc(kitSlug(slugA))}/draft`, auth(marketerB))).statusCode).toBe(404)
    expect((await call('GET', `/${enc(kitSlug(slugA))}/versions`, auth(marketerB))).statusCode).toBe(404)
    const listB = (await call('GET', '/?kind=kit', auth(marketerB))).json() as Array<{ slug: string }>
    expect(listB.map((r) => r.slug)).not.toContain(kitSlug(slugA))
    // The row is bound to A's company.
    expect((await prisma.siteLayout.findUniqueOrThrow({ where: { slug: kitSlug(slugA) } })).tenantId).toBe(tenantA)
    await call('DELETE', `/${enc(kitSlug(slugA))}/draft`, auth(marketer))
  })

  it('a library font of another company is 422; the brand company\'s own font is fine', async () => {
    const foreign = await saveKit(marketer, slugA, { v: 1, fonts: { display: `library:${fontB}` } })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('KIT_FONT_NOT_IN_COMPANY')
    // The CEO (member of both) cannot attach B's font to A's brand either.
    expect((await saveKit(ceo, slugA, { v: 1, fonts: { body: `library:${fontB}` } })).json().error.code).toBe('KIT_FONT_NOT_IN_COMPANY')
    expect((await saveKit(marketer, slugA, { v: 1, fonts: { display: 'library:does-not-exist' } })).statusCode).toBe(422)
    expect((await saveKit(marketer, slugA, { v: 1, fonts: { display: `library:${fontA}`, body: 'inter' } })).statusCode).toBe(200)
    await call('DELETE', `/${enc(kitSlug(slugA))}/draft`, auth(marketer))
  })
})

describe('publish → Concept sync', () => {
  it('draft → submit → CEO approve publishes and syncs only the fields the kit sets', async () => {
    let r = await saveKit(marketer, slugA, {
      v: 1,
      palette: { green: '#06392F' },
      roles: { accent: '#E94E1B', ordering: '#123456' },
      fonts: { display: `library:${fontA}` },
      images: { logo: 'https://cdn.example.com/new-logo.png', mascot: '/brand/bkt-mascot.png' },
    })
    expect(r.statusCode).toBe(200)
    r = await call('POST', `/${enc(kitSlug(slugA))}/submit`, auth(marketer))
    expect(r.json().draftStatus).toBe('pending')

    // Listed as "Brand kit — <Brand>" for the approvals inbox.
    const pending = (await call('GET', '/?status=pending', auth(ceo))).json() as Array<{ slug: string; label: string | null; kind: string }>
    const row = pending.find((p) => p.slug === kitSlug(slugA))
    expect(row).toMatchObject({ kind: 'kit', label: 'Brand kit — BKT brand-a' })

    expect((await call('POST', `/${enc(kitSlug(slugA))}/approve`, auth(marketer), {})).statusCode).toBe(403)
    // Nothing synced before the CEO approves.
    expect((await concept(slugA)).primaryColor).toBe('#111111')

    r = await call('POST', `/${enc(kitSlug(slugA))}/approve`, auth(ceo), {})
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ liveVersion: 1, draftStatus: 'none' })
    expect(await concept(slugA)).toEqual({
      primaryColor: '#123456',
      logoUrl: 'https://cdn.example.com/new-logo.png',
      wordmarkUrl: '/brand/old-wordmark.png', // the kit left it empty: untouched
      mascotUrl: '/brand/bkt-mascot.png',
    })

    // The public per-slug read works and resolves the library font.
    const pub = (await call('GET', `/${enc(kitSlug(slugA))}`)).json()
    expect(pub).toMatchObject({ kind: 'kit', version: 1, blocks: [] })
    expect(pub.settings.kit.roles.ordering).toBe('#123456')
    expect(pub.fonts).toEqual([{ id: `library:${fontA}`, family: 'BktDisplayA', url: expect.stringContaining('.woff2'), format: 'woff2' }])
  })

  it('a later kit that clears a field puts the brand\'s pre-kit value back (never keeps the old kit value)', async () => {
    await saveKit(marketer, slugA, { v: 1, roles: { ordering: '#654321' } })
    const r = await call('POST', `/${enc(kitSlug(slugA))}/approve`, auth(ceo), {})
    expect(r.json().liveVersion).toBe(2)
    expect(await concept(slugA)).toEqual({
      primaryColor: '#654321',
      logoUrl: 'https://cdn.example.com/old-logo.png', // v1 set it, v2 doesn't: pre-kit value
      wordmarkUrl: '/brand/old-wordmark.png',          // no kit ever set it: untouched
      mascotUrl: null,                                 // pre-kit it had none
    })
  })

  it('the pre-kit snapshot is server-only: never in a public, edit or version read, and a draft cannot set it', async () => {
    const stored = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: kitSlug(slugA) } })
    expect((stored.settings as Record<string, unknown>)['conceptBefore']).toEqual({
      primaryColor: '#111111', logoUrl: 'https://cdn.example.com/old-logo.png', wordmarkUrl: '/brand/old-wordmark.png', mascotUrl: null,
    })
    const pub = (await call('GET', `/${enc(kitSlug(slugA))}`)).json()
    expect(pub.settings).toEqual({ kit: { v: 1, roles: { ordering: '#654321' } } })
    const edit = (await call('GET', `/${enc(kitSlug(slugA))}/edit`, auth(marketer))).json()
    expect(Object.keys(edit.settings)).toEqual(['kit'])
    const versions = (await call('GET', `/${enc(kitSlug(slugA))}/versions`, auth(marketer))).json() as Array<{ settings: object }>
    for (const v of versions) expect(Object.keys(v.settings)).toEqual(['kit'])
    const forged = await call('PUT', `/${enc(kitSlug(slugA))}/draft`, auth(marketer), {
      kind: 'kit', blocks: [], settings: { kit: { v: 1 }, conceptBefore: { primaryColor: '#000000', logoUrl: null, wordmarkUrl: null, mascotUrl: null } },
    })
    expect(forged.statusCode).toBe(400)
  })

  it('rollback republishes an old kit and syncs the Concept', async () => {
    expect((await call('POST', `/${enc(kitSlug(slugA))}/rollback`, auth(marketer), { version: 1 })).statusCode).toBe(403)
    const r = await call('POST', `/${enc(kitSlug(slugA))}/rollback`, auth(ceo), { version: 1 })
    expect(r.statusCode).toBe(200)
    expect(r.json().liveVersion).toBe(3)
    expect(await concept(slugA)).toEqual({
      primaryColor: '#123456',
      logoUrl: 'https://cdn.example.com/new-logo.png',
      wordmarkUrl: '/brand/old-wordmark.png',
      mascotUrl: '/brand/bkt-mascot.png',
    })
  })

  it('a scheduled kit syncs when publishDueLayouts publishes it', async () => {
    await saveKit(marketer, slugA, { v: 1, roles: { ordering: '#ABCDEF' }, images: { wordmark: 'https://cdn.example.com/wm.png' } })
    const later = new Date(Date.now() + 3_600_000).toISOString()
    let r = await call('POST', `/${enc(kitSlug(slugA))}/approve`, auth(ceo), { publishAt: later })
    expect(r.json().draftStatus).toBe('scheduled')
    expect((await concept(slugA)).primaryColor).toBe('#123456')
    await prisma.siteLayout.update({ where: { slug: kitSlug(slugA) }, data: { publishAt: new Date(Date.now() - 1000) } })
    expect(await publishDueLayouts({ kind: 'kit' })).toBe(1)
    // v3 (= v1) set logo + mascot; v4 does not: both go back to pre-kit.
    expect(await concept(slugA)).toEqual({
      primaryColor: '#ABCDEF',
      logoUrl: 'https://cdn.example.com/old-logo.png',
      wordmarkUrl: 'https://cdn.example.com/wm.png',
      mascotUrl: null,
    })
    r = await call('GET', `/${enc(kitSlug(slugA))}/edit`, auth(marketer))
    expect(r.json().liveVersion).toBe(4)
  })

  it('a kit never syncs a brand of another company', async () => {
    // A stray kit row stamped with company B for A's brand slug (e.g. stale
    // data): publishing it must not touch A's Concept.
    const before = await concept(slugA)
    const strayBrand = await brand('brand-stray', tenantA, { primaryColor: '#010101' })
    await prisma.siteLayout.create({
      data: {
        slug: kitSlug(strayBrand), kind: 'kit', tenantId: tenantB, blocks: [], liveVersion: 0,
        draftBlocks: [], draftSettings: { kit: { v: 1, roles: { ordering: '#FFFFFF' } } }, draftStatus: 'scheduled',
        draftUpdatedAt: new Date(), publishAt: new Date(Date.now() - 1000),
      },
    })
    await publishDueLayouts({ slug: kitSlug(strayBrand) })
    expect((await concept(strayBrand)).primaryColor).toBe('#010101')
    expect(await concept(slugA)).toEqual(before)
    // ...and /kits/live does not paint A's brand with it.
    const live = (await call('GET', '/kits/live')).json()
    expect(live.kits[strayBrand]).toBeUndefined()
  })
})

describe('public reads', () => {
  it('/kits/live lists only live kits of brands on the storefront', async () => {
    // Hidden brand with a live kit; B brand with a draft-only kit.
    await saveKit(marketer, slugHidden, { v: 1, roles: { accent: '#000000' } })
    expect((await call('POST', `/${enc(kitSlug(slugHidden))}/approve`, auth(ceo), {})).statusCode).toBe(200)
    expect((await saveKit(marketerB, slugB, { v: 1, roles: { accent: '#FFFFFF' } })).statusCode).toBe(200)

    const r = await call('GET', '/kits/live')
    expect(r.statusCode).toBe(200)
    const { kits } = r.json() as { kits: Record<string, { kit: { v: number }; version: number; fonts: unknown[] }> }
    expect(kits[slugA]).toMatchObject({ version: 4, kit: { v: 1, roles: { ordering: '#ABCDEF' } } })
    expect(kits[slugHidden]).toBeUndefined()
    expect(kits[slugB]).toBeUndefined()
  })

  it('/kits/live publishes a due scheduled kit first', async () => {
    await saveKit(marketerB, slugB, { v: 1, roles: { accent: '#FFFFFF' } })
    await call('POST', `/${enc(kitSlug(slugB))}/approve`, auth(ceo), { publishAt: new Date(Date.now() + 3_600_000).toISOString() })
    await prisma.siteLayout.update({ where: { slug: kitSlug(slugB) }, data: { publishAt: new Date(Date.now() - 1000) } })
    const { kits } = (await call('GET', '/kits/live')).json()
    expect(kits[slugB]).toMatchObject({ version: 1, kit: { roles: { accent: '#FFFFFF' } }, fonts: [] })
  })

  it('the kit slug is never in /pages/live (sitemap)', async () => {
    const pages = (await call('GET', '/pages/live')).json() as Array<{ slug: string }>
    expect(pages.some((p) => p.slug.endsWith(':kit'))).toBe(false)
  })
})

describe('removing a kit', () => {
  it('DELETE of a live kit puts every field it set back to the pre-kit values', async () => {
    const b = await brand('brand-del', tenantA, { primaryColor: '#222222', logoUrl: null })
    await saveKit(marketer, b, { v: 1, roles: { ordering: '#333333' }, images: { logo: 'https://cdn.example.com/del-logo.png' } })
    expect((await call('POST', `/${enc(kitSlug(b))}/approve`, auth(ceo), {})).statusCode).toBe(200)
    expect(await concept(b)).toMatchObject({ primaryColor: '#333333', logoUrl: 'https://cdn.example.com/del-logo.png' })
    expect((await call('DELETE', `/${enc(kitSlug(b))}`, auth(marketer))).statusCode).toBe(403)
    expect((await call('DELETE', `/${enc(kitSlug(b))}`, auth(ceo))).statusCode).toBe(204)
    expect(await concept(b)).toEqual({ primaryColor: '#222222', logoUrl: null, wordmarkUrl: null, mascotUrl: null })
    expect(await prisma.siteLayout.findUnique({ where: { slug: kitSlug(b) } })).toBeNull()
  })
})

describe('public per-slug read', () => {
  it('returns the empty shape for a brand that is hidden, retired or deleted; staff still read it via /edit', async () => {
    // slugHidden has a live kit (published in "public reads" above, or here).
    const row = await prisma.siteLayout.findUnique({ where: { slug: kitSlug(slugHidden) } })
    if (!row || row.liveVersion === 0) {
      await saveKit(marketer, slugHidden, { v: 1, roles: { accent: '#000000' } })
      expect((await call('POST', `/${enc(kitSlug(slugHidden))}/approve`, auth(ceo), {})).statusCode).toBe(200)
    }
    const pub = (await call('GET', `/${enc(kitSlug(slugHidden))}`)).json()
    expect(pub).toMatchObject({ version: 0, settings: null, blocks: null, fonts: [] })
    const edit = await call('GET', `/${enc(kitSlug(slugHidden))}/edit`, auth(marketer))
    expect(edit.statusCode).toBe(200)
    expect(edit.json().settings.kit.roles.accent).toBe('#000000')

    // A visible brand's kit reads normally; retiring the brand hides it.
    expect((await call('GET', `/${enc(kitSlug(slugA))}`)).json().version).toBeGreaterThan(0)
    await prisma.concept.update({ where: { slug: slugA }, data: { isActive: false } })
    try {
      expect((await call('GET', `/${enc(kitSlug(slugA))}`)).json()).toMatchObject({ version: 0, settings: null })
    } finally {
      await prisma.concept.update({ where: { slug: slugA }, data: { isActive: true } })
    }
  })
})

describe('Concept PATCH: the kit owns the brand\'s look', () => {
  it('logoUrl / wordmarkUrl / mascotUrl / primaryColor are CEO-only; other fields still save', async () => {
    const b = await brand('brand-patch', tenantA, { primaryColor: '#444444' })
    const id = (await prisma.concept.findUniqueOrThrow({ where: { slug: b } })).id
    const patch = (who: U, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/v1/concepts/${id}`, headers: auth(who), payload })
    for (const field of ['logoUrl', 'wordmarkUrl', 'mascotUrl']) {
      const r = await patch(marketer, { [field]: 'https://cdn.example.com/x.png' })
      expect(r.statusCode, field).toBe(403)
      expect(r.json().error.code).toBe('KIT_FIELD_CEO_ONLY')
      expect((await patch(managerA, { [field]: 'https://cdn.example.com/x.png' })).statusCode, field).toBe(403)
    }
    expect((await patch(marketer, { primaryColor: '#ff0000' })).statusCode).toBe(403)
    expect((await patch(managerA, { primaryColor: '#ff0000', phone: '0300' })).statusCode).toBe(403)
    expect((await concept(b)).primaryColor).toBe('#444444')
    // Copy still saves for the marketing tier and management.
    expect((await patch(marketer, { heroTagline: 'new line' })).statusCode).toBe(200)
    expect((await patch(managerA, { phone: '0300' })).statusCode).toBe(200)
    // The CEO may still set them.
    expect((await patch(ceo, { primaryColor: '#555555' })).statusCode).toBe(200)
    expect((await concept(b)).primaryColor).toBe('#555555')
  })
})

describe('Library font family', () => {
  it('PATCH /media/:id refuses a family that would break the storefront CSS (422 FONT_FAMILY_INVALID)', async () => {
    const f = await font(tenantA, 'BktSafe')
    const patch = (fontFamily: string) =>
      app.inject({ method: 'PATCH', url: `/api/v1/media/${f}`, headers: auth(marketer), payload: { fontFamily } })
    for (const bad of ['Foo\nBar', 'Foo"Bar', "Foo'Bar", 'Foo;}:root{', 'Foo\\Bar', 'Foo<x>', 'Foo\u0000']) {
      const r = await patch(bad)
      expect(r.statusCode, JSON.stringify(bad)).toBe(422)
      expect(r.json().error.code).toBe('FONT_FAMILY_INVALID')
    }
    expect((await patch('Bricolage Grotesque 2.0_x-y')).statusCode).toBe(200)
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: f } })).fontFamily).toBe('Bricolage Grotesque 2.0_x-y')
  })

  it('a stored family with a newline (older row) is cleaned before /kits/live serves it', async () => {
    const f = await font(tenantA, 'BktOld')
    await prisma.mediaAsset.update({ where: { id: f }, data: { fontFamily: 'Bkt\nOld"};' } })
    const b = await brand('brand-font', tenantA)
    await prisma.siteLayout.create({
      data: { slug: kitSlug(b), kind: 'kit', tenantId: tenantA, blocks: [], settings: { kit: { v: 1, fonts: { display: `library:${f}` } } }, liveVersion: 1 },
    })
    const { kits } = (await call('GET', '/kits/live')).json()
    expect(kits[b].fonts).toEqual([expect.objectContaining({ id: `library:${f}`, family: 'Bkt Old' })])
  })
})

describe('round-2 review fixes', () => {
  it('rv-1: an upload CLEANS a given font family (commas, brackets) instead of refusing it', async () => {
    const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL'] as const
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    Object.assign(process.env, { R2_ACCOUNT_ID: 'bkt-test', R2_ACCESS_KEY_ID: 'bkt', R2_SECRET_ACCESS_KEY: 'bkt', R2_PUBLIC_URL: 'https://cdn.example.com' })
    try {
      const cases: Array<[string, string, string]> = [
        ['Inter-VariableFont_opsz,wght.ttf', 'Inter VariableFont opsz,wght', 'Inter VariableFont opsz wght'],
        ['Roboto-Italic[wdth,wght].ttf', 'Roboto Italic[wdth,wght]', 'Roboto Italic wdth wght'],
        ['Gotham Book (1).otf', 'Gotham Book (1)', 'Gotham Book 1'],
      ]
      for (const [filename, family, cleaned] of cases) {
        const q = new URLSearchParams({ filename, contentType: filename.endsWith('.otf') ? 'font/otf' : 'font/ttf', kind: 'font', fontFamily: family })
        const r = await app.inject({ method: 'GET', url: `/api/v1/media/upload-url?${q}`, headers: auth(marketer) })
        expect(r.statusCode, filename).toBe(200)
        const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: r.json().assetId } })
        expect(asset.fontFamily).toBe(cleaned)
        expect(asset.tenantId).toBe(tenantA)
      }
      // Nothing usable left: falls back to the name / file name.
      const q = new URLSearchParams({ filename: 'Bkt-Fallback.woff2', contentType: 'font/woff2', kind: 'font', fontFamily: '"();' })
      const r = await app.inject({ method: 'GET', url: `/api/v1/media/upload-url?${q}`, headers: auth(marketer) })
      expect(r.statusCode).toBe(200)
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: r.json().assetId } })).fontFamily).toBe('Bkt-Fallback')
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    }
  })

  it('rv-2: a page using an older library font gets its face under the CLEANED family', async () => {
    const f = await font(tenantA, 'BktPageFont')
    await prisma.mediaAsset.update({ where: { id: f }, data: { fontFamily: 'Bkt Gotham (1)' } })
    const b = await brand('brand-pagefont', tenantA)
    await prisma.siteLayout.create({
      data: { slug: `brand:${b}`, kind: 'page', tenantId: tenantA, liveVersion: 1,
        blocks: [{ id: 'x1', type: 'text', text: 'hi', fontFamily: 'Bkt Gotham (1)' }], settings: {} },
    })
    const pub = (await call('GET', `/${enc(`brand:${b}`)}`)).json()
    expect(pub.fonts).toEqual([{ family: 'Bkt Gotham 1', url: expect.stringContaining('.woff2') }])
  })

  it('rv-5: discarding a never-published row is conditional — a row that went live answers 409 and is kept', async () => {
    const b = await brand('brand-discard', tenantA, { primaryColor: '#777777' })
    expect((await saveKit(marketer, b, { v: 1, roles: { ordering: '#888888' } })).statusCode).toBe(200)
    // Plain discard of a never-published draft still deletes the row.
    expect((await call('DELETE', `/${enc(kitSlug(b))}/draft`, auth(marketer))).statusCode).toBe(204)
    expect(await prisma.siteLayout.findUnique({ where: { slug: kitSlug(b) } })).toBeNull()

    // A first publish landing between the discard's read (liveVersion 0) and
    // its delete: the route's loadRow read is intercepted and the CEO approves
    // right after it, before the delete runs.
    expect((await saveKit(marketer, b, { v: 1, roles: { ordering: '#999999' } })).statusCode).toBe(200)
    const id = (await prisma.siteLayout.findUniqueOrThrow({ where: { slug: kitSlug(b) } })).id
    const delegate = routePrisma.siteLayout as unknown as { findUnique: (a: unknown) => Promise<unknown> }
    const original = delegate.findUnique
    let raced = false
    let approved = 0
    delegate.findUnique = async (args: unknown) => {
      const r = await original(args) as { id: string; liveVersion: number } | null
      if (!raced && r?.id === id && r.liveVersion === 0) {
        raced = true
        delegate.findUnique = original
        approved = (await call('POST', `/${enc(kitSlug(b))}/approve`, auth(ceo), {})).statusCode
      }
      return r
    }
    try {
      const r = await call('DELETE', `/${enc(kitSlug(b))}/draft`, auth(marketer))
      expect(raced).toBe(true)
      expect(approved).toBe(200)
      expect(r.statusCode).toBe(409)
      const kept = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: kitSlug(b) } })
      expect(kept.liveVersion).toBe(1)
      expect((await concept(b)).primaryColor).toBe('#999999')
    } finally {
      delegate.findUnique = original
    }
  })

  it('rv-7: a CEO PATCH of a kit-owned field while a kit is live refreshes the snapshot, so a later kit keeps the CEO edit', async () => {
    const b = await brand('brand-ceoedit', tenantA, { primaryColor: '#101010', logoUrl: 'https://cdn.example.com/l0.png' })
    const id = (await prisma.concept.findUniqueOrThrow({ where: { slug: b } })).id
    await saveKit(marketer, b, { v: 1, images: { logo: 'https://cdn.example.com/l1.png' } })
    expect((await call('POST', `/${enc(kitSlug(b))}/approve`, auth(ceo), {})).statusCode).toBe(200)
    expect((await concept(b)).logoUrl).toBe('https://cdn.example.com/l1.png')

    const r = await app.inject({ method: 'PATCH', url: `/api/v1/concepts/${id}`, headers: auth(ceo), payload: { logoUrl: 'https://cdn.example.com/x.png' } })
    expect(r.statusCode).toBe(200)
    const stored = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: kitSlug(b) } })
    expect((stored.settings as Record<string, Record<string, unknown>>)['conceptBefore']).toMatchObject({
      logoUrl: 'https://cdn.example.com/x.png', primaryColor: '#101010',
    })
    // The public read never shows the snapshot.
    expect(Object.keys((await call('GET', `/${enc(kitSlug(b))}`)).json().settings)).toEqual(['kit'])

    // Kit v2 stops setting the logo: the brand keeps the CEO's value, not l0.
    await saveKit(marketer, b, { v: 1, roles: { accent: '#E94E1B' } })
    expect((await call('POST', `/${enc(kitSlug(b))}/approve`, auth(ceo), {})).statusCode).toBe(200)
    expect((await concept(b)).logoUrl).toBe('https://cdn.example.com/x.png')

    // A brand with no live kit: the PATCH changes only the Concept.
    const plain = await brand('brand-ceoedit-nokit', tenantA)
    const pid = (await prisma.concept.findUniqueOrThrow({ where: { slug: plain } })).id
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/concepts/${pid}`, headers: auth(ceo), payload: { primaryColor: '#202020' } })).statusCode).toBe(200)
    expect(await prisma.siteLayout.findUnique({ where: { slug: kitSlug(plain) } })).toBeNull()
  })
})

describe('company merge', () => {
  it('moves brand kits and Library assets with the company', async () => {
    const src = await company('msrc')
    const dst = await company('mdst')
    await ensureChartOfAccounts(src)
    await ensureChartOfAccounts(dst)
    await prisma.tenantMember.createMany({ data: [{ tenantId: src, userId: ceo.id }, { tenantId: dst, userId: ceo.id }] })
    const b = await brand('brand-merge', src)
    const f = await font(src, 'BktMerge')
    await prisma.siteLayout.create({
      data: { slug: kitSlug(b), kind: 'kit', tenantId: src, blocks: [], settings: { kit: { v: 1, fonts: { display: `library:${f}` } } }, liveVersion: 1 },
    })
    const r = await app.inject({ method: 'POST', url: '/api/v1/tenants/merge', headers: auth(ceo), payload: { sourceId: src, targetId: dst } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.siteLayout.findUniqueOrThrow({ where: { slug: kitSlug(b) } })).tenantId).toBe(dst)
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: f } })).tenantId).toBe(dst)
    // The kit's library font still resolves inside its (new) company.
    const { kits } = (await call('GET', '/kits/live')).json()
    expect(kits[b].fonts).toHaveLength(1)
  })
})
