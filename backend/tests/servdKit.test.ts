// The servd kit (owner, 2026-11-23: "give servd brand kit also. Link it to gs
// foods? Cause I own servd"): servd.pk's own look in ONE row `servd:kit`
// (kind 'kit'), owned by a company (the CEO's ACTIVE company at first save —
// GS Foods), CEO only. Two companies: company B's CEO never sees or edits
// company A's servd kit (404), a marketer with the Storefront module gets 403
// SERVD_KIT_CEO_ONLY, the owning company never changes, library fonts resolve
// in that company, kits/live carries kits.servd only once published, no
// Concept is touched and brand kits are unaffected.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { siteLayoutRoutes } = await import('../src/modules/siteLayouts/routes.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { parseSlug } = await import('../src/modules/siteLayouts/service.js')

const PREFIX = 'svk'
const STAMP = Date.now()
const SLUG = 'servd:kit'
const ENC = encodeURIComponent(SLUG)
let app: FastifyInstance
let tenantA: string
let tenantB: string
let brandA = ''
let fontA = ''
let fontB = ''
type U = { id: string; name: string; email: string; role: string }
let ceo: U
let ceoB: U
let marketer: U
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
const auth = (u: U) => ({ authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` })
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/site-layouts${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
const saveServdKit = (who: U, kit: unknown) => call('PUT', `/${ENC}/draft`, auth(who), { kind: 'kit', blocks: [], settings: { kit } })
const conceptLook = (slug: string) => prisma.concept.findUniqueOrThrow({ where: { slug }, select: { primaryColor: true, logoUrl: true, wordmarkUrl: true, mascotUrl: true } })

async function company(label: string) {
  const id = (await prisma.tenant.create({ data: { name: `SVK ${label}`, slug: `${PREFIX}-${label}-${STAMP}` } })).id
  tenantIds.push(id)
  return id
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
  // servd:kit is one row servd-wide: start from none.
  await prisma.siteLayout.deleteMany({ where: { slug: SLUG } })
  tenantA = await company('a')
  tenantB = await company('b')
  brandA = `${PREFIX}-brand-a-${STAMP}`
  await prisma.concept.create({ data: { name: 'SVK brand A', slug: brandA, type: 'restaurant', tenantId: tenantA, primaryColor: '#111111', logoUrl: 'https://cdn.example.com/a.png' } })
  conceptSlugs.push(brandA)
  fontA = await font(tenantA, 'SvkDisplayA')
  fontB = await font(tenantB, 'SvkDisplayB')
  ceo = await makeUser('ceo', 'admin', tenantA, [tenantA])
  ceoB = await makeUser('ceob', 'admin', tenantB, [tenantB])
  marketer = await makeUser('mkt', 'marketing', tenantA, [tenantA])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', details: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[servdKit] 500:', err)
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
    await api.register(conceptRoutes, { prefix: '/concepts' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await prisma.siteLayout.deleteMany({ where: { OR: [{ slug: SLUG }, { tenantId: { in: tenantIds } }] } })
  await prisma.mediaAsset.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.tenantMember.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { tenantId: { in: tenantIds } }] } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.concept.deleteMany({ where: { slug: { in: conceptSlugs } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {})
})

describe('servd kit', () => {
  it('servd:kit parses as the servd kit; other servd pages are unchanged', () => {
    expect(parseSlug(SLUG)).toEqual({ owner: 'servd_kit', kind: 'kit' })
    expect(parseSlug('servd:home')).toEqual({ owner: 'shared', kind: 'page' })
    expect(parseSlug('servd:header')?.kind).toBe('header')
  })

  it('a marketer with the Storefront module is refused every servd kit route (403 SERVD_KIT_CEO_ONLY)', async () => {
    for (const r of [
      await call('GET', `/${ENC}/edit`, auth(marketer)),
      await saveServdKit(marketer, { v: 1, palette: { green: '#112233' } }),
      await call('POST', `/${ENC}/submit`, auth(marketer)),
      await call('GET', `/${ENC}/versions`, auth(marketer)),
      await call('POST', `/${ENC}/approve`, auth(marketer), {}),
    ]) {
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('SERVD_KIT_CEO_ONLY')
    }
    expect(await prisma.siteLayout.findUnique({ where: { slug: SLUG } })).toBeNull()
  })

  it('kits/live has no servd entry before anything is published', async () => {
    const live = (await call('GET', '/kits/live')).json()
    expect(live.kits.servd).toBeUndefined()
  })

  it('the CEO drafts it in the ACTIVE company; a library font must be that company\'s', async () => {
    const skeleton = await call('GET', `/${ENC}/edit`, auth(ceo))
    expect(skeleton.statusCode).toBe(200)
    expect(skeleton.json()).toMatchObject({ kind: 'kit', tenantId: tenantA, liveVersion: 0 })

    const foreignFont = await saveServdKit(ceo, { v: 1, fonts: { display: `library:${fontB}` } })
    expect(foreignFont.statusCode).toBe(422)
    expect(foreignFont.json().error.code).toBe('KIT_FONT_NOT_IN_COMPANY')

    const before = await conceptLook(brandA)
    const r = await saveServdKit(ceo, {
      v: 1, palette: { green: '#22aa55', purple: '#4400aa' }, fonts: { display: `library:${fontA}` }, images: { logo: 'https://cdn.example.com/servd-new.png' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ kind: 'kit', tenantId: tenantA, draftStatus: 'draft' })
    const row = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: SLUG } })
    expect(row.tenantId).toBe(tenantA)
    expect(await conceptLook(brandA)).toEqual(before)
    // Listed to the CEO, never to the marketer.
    const ceoList = (await call('GET', '/', auth(ceo))).json() as Array<{ slug: string; label: string | null }>
    expect(ceoList.find((x) => x.slug === SLUG)?.label).toBe('servd kit — servd.pk')
    const mktList = (await call('GET', '/', auth(marketer))).json() as Array<{ slug: string }>
    expect(mktList.some((x) => x.slug === SLUG)).toBe(false)
  })

  it("another company's CEO cannot read, edit, approve or delete it (404)", async () => {
    expect((await call('GET', `/${ENC}/edit`, auth(ceoB))).statusCode).toBe(404)
    expect((await saveServdKit(ceoB, { v: 1, palette: { green: '#000000' } })).statusCode).toBe(404)
    expect((await call('POST', `/${ENC}/submit`, auth(ceoB))).statusCode).toBe(404)
    expect((await call('DELETE', `/${ENC}`, auth(ceoB))).statusCode).toBe(404)
    const appr = await call('POST', `/${ENC}/approve`, auth(ceoB), {})
    expect([403, 404]).toContain(appr.statusCode)
    const list = (await call('GET', '/', auth(ceoB))).json() as Array<{ slug: string }>
    expect(list.some((x) => x.slug === SLUG)).toBe(false)
    const row = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: SLUG } })
    expect(row.tenantId).toBe(tenantA)
    expect(row.liveVersion).toBe(0)
  })

  it('the CEO approves it: kits/live carries kits.servd (live version only); no Concept is touched', async () => {
    const before = await conceptLook(brandA)
    const ok = await call('POST', `/${ENC}/approve`, auth(ceo), {})
    expect(ok.statusCode).toBe(200)
    expect(ok.json().liveVersion).toBe(1)
    const live = (await call('GET', '/kits/live')).json()
    expect(live.kits.servd).toMatchObject({ version: 1, kit: { palette: { green: '#22aa55', purple: '#4400aa' }, images: { logo: 'https://cdn.example.com/servd-new.png' } } })
    expect(live.kits.servd.fonts).toEqual([expect.objectContaining({ id: `library:${fontA}`, family: 'SvkDisplayA' })])
    expect(await conceptLook(brandA)).toEqual(before)
    // The live settings carry no pre-kit Concept snapshot.
    const row = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: SLUG } })
    expect(Object.keys(row.settings as object)).toEqual(['kit'])

    // A new draft does not change what is live until approved.
    expect((await saveServdKit(ceo, { v: 1, palette: { green: '#999999' } })).statusCode).toBe(200)
    expect((await call('GET', '/kits/live')).json().kits.servd.kit.palette.green).toBe('#22aa55')
  })

  it('the owning company never changes, even when the CEO saves from another active company', async () => {
    const both = await makeUser('ceoab', 'admin', tenantB, [tenantA, tenantB])
    const r = await saveServdKit(both, { v: 1, palette: { green: '#123456' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await prisma.siteLayout.findUniqueOrThrow({ where: { slug: SLUG } })).tenantId).toBe(tenantA)
  })

  it('brand kits are unaffected: a brand kit still publishes and syncs its own brand', async () => {
    const slug = encodeURIComponent(`brand:${brandA}:kit`)
    expect((await call('PUT', `/${slug}/draft`, auth(marketer), { kind: 'kit', blocks: [], settings: { kit: { v: 1, roles: { ordering: '#abcdef' } } } })).statusCode).toBe(200)
    expect((await call('POST', `/${slug}/approve`, auth(ceo), {})).statusCode).toBe(200)
    expect((await conceptLook(brandA)).primaryColor).toBe('#abcdef')
    const live = (await call('GET', '/kits/live')).json()
    expect(live.kits[brandA]).toMatchObject({ version: 1 })
    expect(live.kits.servd.kit.palette.green).toBe('#22aa55')
  })

  it('no brand may take the address /servd', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/concepts', headers: auth(ceo), payload: { name: 'servd', slug: 'servd', type: 'restaurant', serviceVessel: 'plate' } })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BRAND_SLUG_RESERVED')
  })

  it('the CEO removes it; kits/live drops it', async () => {
    expect((await call('DELETE', `/${ENC}`, auth(ceo))).statusCode).toBe(204)
    expect((await call('GET', '/kits/live')).json().kits.servd).toBeUndefined()
  })
})
