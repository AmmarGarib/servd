// Scroll effects on storefront blocks (D4 stage 1): `block.motion`.
//
// The block schema accepts `motion: { preset, intensity? }` on any block —
// top level, inside a column, and in the A/B variant — and rejects junk.
// Old layouts (no motion) parse exactly as before. Drafts, submit, CEO
// approve, the public read and the version history carry motion as plain
// data, and company separation is unchanged.
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
const {
  blocksSchema, blockSchema, pageSettingsSchema, motionSchema, MOTION_PRESETS, MOTION_INTENSITIES,
} = await import('../src/modules/siteLayouts/schemas.js')

const PREFIX = 'sfm'
const STAMP = Date.now()
let app: FastifyInstance
let tenantA: string
let tenantB: string
let slugA = ''
let slugB = ''
type U = { id: string; name: string; email: string; role: string }
let ceo: U
let marketer: U
let marketerB: U
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

/** A layout as it was saved before scroll effects existed. */
const OLD_BLOCKS = [
  {
    id: 'hero-1', type: 'hero', title: 'Hello', subtitle: 'Old page',
    animation: 'fade-up', animationDelayMs: 150, animationDurationMs: 900,
    primaryCta: { text: 'Order', href: '/home#kitchens' },
  },
  {
    id: 'cols-1', type: 'columns', gap: 'md', stackOnMobile: true,
    columns: [
      [{ id: 'txt-1', type: 'text', body: 'Left', animation: 'zoom-in' }],
      [{ id: 'txt-2', type: 'text', body: 'Right', fontFamily: 'Inter' }],
    ],
  },
  {
    id: 'sec-1', type: 'section', variant: 'stackd.hero',
    fields: { title: 'Stackd', items: [{ label: 'One' }, { label: 'Two' }], colour: 'var(--stackd-plum)' },
  },
]

const withMotion = (motion: unknown) => [{ id: 'm-1', type: 'text', body: 'Moving', motion }]

const JUNK_MOTION: Array<[string, unknown]> = [
  ['an unknown preset', { preset: 'wobble' }],
  ['a preset in the wrong case', { preset: 'FADE' }],
  ['an unknown intensity', { preset: 'fade', intensity: 'extreme' }],
  ['an extra key', { preset: 'fade', intensity: 'medium', keyframes: [] }],
  ['a bare string', 'fade'],
  ['a number', 3],
  ['an array', []],
  ['an empty object', {}],
]

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SFM Co A', slug: `${PREFIX}-a-${STAMP}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SFM Co B', slug: `${PREFIX}-b-${STAMP}` } })).id
  slugA = `${PREFIX}-brand-a-${STAMP}`
  slugB = `${PREFIX}-brand-b-${STAMP}`
  await prisma.concept.create({ data: { name: 'SFM Brand A', slug: slugA, type: 'restaurant', tenantId: tenantA } })
  await prisma.concept.create({ data: { name: 'SFM Brand B', slug: slugB, type: 'restaurant', tenantId: tenantB } })
  ceo = await makeUser('ceo', 'admin', tenantA, [tenantA, tenantB])
  marketer = await makeUser('mkt', 'marketing', tenantA, [tenantA])
  marketerB = await makeUser('mktb', 'marketing', tenantB, [tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', details: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[siteLayoutMotion] 500:', err)
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
  await prisma.concept.deleteMany({ where: { slug: { in: [slugA, slugB] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('motion schema', () => {
  it('the preset and intensity lists are the contract lists, in order', () => {
    expect([...MOTION_PRESETS]).toEqual(['parallax', 'fade', 'grow', 'pin-reveal', 'sticky-stack', 'side-pan', 'text-reveal'])
    expect([...MOTION_INTENSITIES]).toEqual(['subtle', 'medium', 'strong'])
  })

  it('old blocks (no motion) parse exactly as before', () => {
    const parsed = blocksSchema.parse(OLD_BLOCKS)
    expect(parsed).toEqual(OLD_BLOCKS)
    // No key is invented on the way through (the stored JSON is unchanged).
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(OLD_BLOCKS)
    expect(Object.keys(parsed[0]!)).not.toContain('motion')
  })

  it('the entrance animation rules are unchanged', () => {
    expect(() => blockSchema.parse({ id: 'a', type: 'text', animation: 'spin' })).toThrow(ZodError)
    expect(() => blockSchema.parse({ id: 'a', type: 'text', animationDelayMs: 3001 })).toThrow(ZodError)
    expect(() => blockSchema.parse({ id: 'a', type: 'text', animationDurationMs: 199 })).toThrow(ZodError)
  })

  it('accepts every preset with every intensity, and without one', () => {
    for (const preset of MOTION_PRESETS) {
      expect(blocksSchema.parse(withMotion({ preset }))[0]!.motion).toEqual({ preset })
      for (const intensity of MOTION_INTENSITIES) {
        expect(blocksSchema.parse(withMotion({ preset, intensity }))[0]!.motion).toEqual({ preset, intensity })
      }
    }
  })

  it('motion and the entrance animation compose on one block', () => {
    const b = { id: 'x', type: 'image', url: '/a.jpg', animation: 'fade-up', motion: { preset: 'parallax', intensity: 'strong' } }
    expect(blockSchema.parse(b)).toEqual(b)
  })

  it('accepts motion on a column child and inside the A/B variant', () => {
    const cols = [{
      id: 'c', type: 'columns',
      columns: [
        [{ id: 'c1', type: 'image', url: '/x.jpg', motion: { preset: 'grow', intensity: 'subtle' } }],
        [{ id: 'c2', type: 'section', variant: 'servd.nav', motion: { preset: 'text-reveal' } }],
      ],
      motion: { preset: 'fade' },
    }]
    expect(blocksSchema.parse(cols)).toEqual(cols)

    const settings = { ab: { splitPct: 50, blocks: withMotion({ preset: 'sticky-stack', intensity: 'strong' }) } }
    expect(pageSettingsSchema.parse(settings)).toEqual(settings)
  })

  it.each(JUNK_MOTION)('rejects %s', (_label, motion) => {
    expect(() => blocksSchema.parse(withMotion(motion))).toThrow(ZodError)
    expect(motionSchema.safeParse(motion).success).toBe(false)
  })

  it('rejects junk motion inside a column and inside the A/B variant', () => {
    const cols = [{ id: 'c', type: 'columns', columns: [[{ id: 'c1', type: 'text', motion: { preset: 'wobble' } }], []] }]
    expect(() => blocksSchema.parse(cols)).toThrow(ZodError)
    expect(() => pageSettingsSchema.parse({ ab: { splitPct: 50, blocks: withMotion('fade') } })).toThrow(ZodError)
  })

  it('motion: null means none and is dropped from the stored JSON', () => {
    const parsed = blocksSchema.parse(withMotion(null))
    const stored = JSON.parse(JSON.stringify(parsed)) as Array<Record<string, unknown>>
    expect(stored[0]).toEqual({ id: 'm-1', type: 'text', body: 'Moving' })
    expect('motion' in stored[0]!).toBe(false)
  })

  it('motion: null on a column child and in the A/B variant is dropped too', () => {
    const cols = [{
      id: 'c', type: 'columns', gap: 'sm',
      columns: [
        [{ id: 'c1', type: 'text', body: 'A', motion: null }],
        [{ id: 'c2', type: 'text', body: 'B', motion: { preset: 'fade' } }],
      ],
    }]
    const stored = JSON.parse(JSON.stringify(blocksSchema.parse(cols))) as Array<Record<string, unknown>>
    const columns = stored[0]!['columns'] as Array<Array<Record<string, unknown>>>
    expect(columns[0]![0]).toEqual({ id: 'c1', type: 'text', body: 'A' })
    expect('motion' in columns[0]![0]!).toBe(false)
    expect(columns[1]![0]).toEqual({ id: 'c2', type: 'text', body: 'B', motion: { preset: 'fade' } })
    expect(stored[0]!['gap']).toBe('sm')

    const settings = JSON.parse(JSON.stringify(pageSettingsSchema.parse({ ab: { splitPct: 50, blocks: cols } }))) as {
      ab: { blocks: Array<{ columns: Array<Array<Record<string, unknown>>> }> }
    }
    expect('motion' in settings.ab.blocks[0]!.columns[0]![0]!).toBe(false)
  })

  it('a columns block with a bad child is still rejected', () => {
    const nested = [{ id: 'c', type: 'columns', columns: [[{ id: 'n', type: 'columns', columns: [[], []] }], []] }]
    expect(() => blocksSchema.parse(nested)).toThrow(ZodError)
    expect(() => blocksSchema.parse([{ id: 'c', type: 'columns', columns: [[]] }])).toThrow(ZodError)
  })
})

describe('motion through the routes', () => {
  const page = () => `brand:${slugA}:about`

  const BLOCKS = [
    { id: 'h', type: 'hero', title: 'About', animation: 'fade-up', motion: { preset: 'pin-reveal', intensity: 'strong' } },
    {
      id: 'c', type: 'columns',
      columns: [
        [{ id: 'c1', type: 'text', body: 'A', motion: { preset: 'side-pan' } }],
        [{ id: 'c2', type: 'text', body: 'B' }],
      ],
    },
    { id: 's1', type: 'image', url: '/1.jpg', motion: { preset: 'sticky-stack', intensity: 'subtle' } },
    { id: 's2', type: 'image', url: '/2.jpg', motion: { preset: 'sticky-stack', intensity: 'medium' } },
  ]
  const SETTINGS = { ab: { splitPct: 30, blocks: [{ id: 'b', type: 'text', body: 'B side', motion: { preset: 'fade', intensity: 'subtle' } }] } }

  it('rejects junk motion with 400 VALIDATION_ERROR', async () => {
    for (const [, motion] of JUNK_MOTION) {
      const r = await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks: withMotion(motion) })
      expect(r.statusCode).toBe(400)
      expect(r.json().error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('draft → submit → CEO approve carries motion unchanged to the live page and the versions', async () => {
    let r = await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks: BLOCKS, settings: SETTINGS })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tenantId: tenantA, draftStatus: 'draft' })

    r = await call('GET', `/${enc(page())}/edit`, auth(marketer))
    expect(r.statusCode).toBe(200)
    expect(r.json().draftBlocks).toEqual(BLOCKS)
    expect(r.json().draftSettings).toEqual(SETTINGS)

    r = await call('POST', `/${enc(page())}/submit`, auth(marketer))
    expect(r.json().draftStatus).toBe('pending')

    r = await call('POST', `/${enc(page())}/approve`, auth(ceo), {})
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ liveVersion: 1, draftStatus: 'none' })

    const pub = (await call('GET', `/${enc(page())}`)).json()
    expect(pub.version).toBe(1)
    expect(pub.blocks).toEqual(BLOCKS)
    expect(pub.settings).toEqual(SETTINGS)

    const versions = (await call('GET', `/${enc(page())}/versions`, auth(marketer))).json()
    expect(versions).toHaveLength(1)
    expect(versions[0].blocks).toEqual(BLOCKS)
    expect(versions[0].settings).toEqual(SETTINGS)
  })

  it('a junk PUT leaves the stored draft unchanged', async () => {
    const good = withMotion({ preset: 'grow' })
    expect((await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks: good })).statusCode).toBe(200)
    const before = (await call('GET', `/${enc(page())}/edit`, auth(marketer))).json()

    const bad = await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks: withMotion({ preset: 'grow', intensity: 'max' }) })
    expect(bad.statusCode).toBe(400)

    const after = (await call('GET', `/${enc(page())}/edit`, auth(marketer))).json()
    expect(after.draftBlocks).toEqual(good)
    expect(after.draftUpdatedAt).toBe(before.draftUpdatedAt)
    // The live page is still the approved version.
    expect((await call('GET', `/${enc(page())}`)).json().blocks).toEqual(BLOCKS)
  })

  it('motion: null through the route is stored without the key', async () => {
    const r = await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks: withMotion(null) })
    expect(r.statusCode).toBe(200)
    const draft = (await call('GET', `/${enc(page())}/edit`, auth(marketer))).json().draftBlocks
    expect(draft).toEqual([{ id: 'm-1', type: 'text', body: 'Moving' }])
  })

  it('motion: null on a column child through the route is stored without the key', async () => {
    const blocks = [{
      id: 'c', type: 'columns',
      columns: [[{ id: 'c1', type: 'text', body: 'A', motion: null }], [{ id: 'c2', type: 'text', body: 'B' }]],
    }]
    const r = await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks })
    expect(r.statusCode).toBe(200)
    const draft = (await call('GET', `/${enc(page())}/edit`, auth(marketer))).json().draftBlocks
    expect(draft).toEqual([{
      id: 'c', type: 'columns',
      columns: [[{ id: 'c1', type: 'text', body: 'A' }], [{ id: 'c2', type: 'text', body: 'B' }]],
    }])
    expect('motion' in draft[0].columns[0][0]).toBe(false)
    // Put the draft the next test expects back.
    expect((await call('PUT', `/${enc(page())}/draft`, auth(marketer), { blocks: withMotion(null) })).statusCode).toBe(200)
  })

  it("company B's marketer cannot read or write company A's brand page (404)", async () => {
    expect((await call('GET', `/${enc(page())}/edit`, auth(marketerB))).statusCode).toBe(404)
    const r = await call('PUT', `/${enc(page())}/draft`, auth(marketerB), { blocks: withMotion({ preset: 'fade' }) })
    expect(r.statusCode).toBe(404)
    // Untouched by the refused write.
    const draft = (await call('GET', `/${enc(page())}/edit`, auth(marketer))).json().draftBlocks
    expect(draft).toEqual([{ id: 'm-1', type: 'text', body: 'Moving' }])
  })

  it("company B's marketer can still use motion on its own brand", async () => {
    const r = await call('PUT', `/${enc(`brand:${slugB}`)}/draft`, auth(marketerB), { blocks: withMotion({ preset: 'parallax', intensity: 'subtle' }) })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tenantId: tenantB })
    expect(r.json().draftBlocks[0].motion).toEqual({ preset: 'parallax', intensity: 'subtle' })
  })
})
