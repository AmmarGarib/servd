// Company separation — content, marketing, menu and recipe routes (2026-09-27).
//
// Two companies, A and B. Each case is a way company B could reach company A's
// data through a route that trusted an id or treated a brand-less row as
// "everyone's":
//   - gift cards: B cannot see, void or redeem A's card at B's till or
//     against B's order (404), and a card never pays another company's order;
//   - calendar: B cannot see or edit A's brand-less events, or assign them to
//     A's staff;
//   - media: B cannot list or delete A's assets;
//   - promo codes: B cannot see/edit A's brand-less promo, and A's code is not
//     valid at B's brand;
//   - storefront deals strip + abandoned-cart metrics are company-scoped;
//   - menu: an item cannot be moved into another company's category/brand,
//     even by a head-office user who belongs to both companies;
//   - recipes: A's sub-recipes, pending approvals and steps are 404 to B, and
//     stations must be the recipe's company's.
//
// Drives the real route handlers through Fastify inject against the
// disposable test database (DATABASE_URL must contain "test") and Redis.
import { parSheetRoutes } from '../src/modules/par-sheet/routes.js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { giftCardRoutes } = await import('../src/modules/giftCards/routes.js')
const { calendarRoutes } = await import('../src/modules/calendar/routes.js')
const { mediaRoutes } = await import('../src/modules/media/routes.js')
const { promoRoutes } = await import('../src/modules/promos/routes.js')
const { menuRoutes } = await import('../src/modules/menu/routes.js')
const { recipeRoutes } = await import('../src/modules/recipes/routes.js')
const { storefrontRoutes } = await import('../src/modules/storefront/routes.js')
const { expoRoutes } = await import('../src/modules/expo/routes.js')

const PREFIX = 'sep-content'
const STAMP = Date.now()
let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let slugA = '', slugB = ''
let conceptB: string
let catA: string
let catB: string
let stationA: string
let stationB: string
let userA: { id: string; name: string; email: string; role: string }
let userB: { id: string; name: string; email: string; role: string }
let userHQ: { id: string; name: string; email: string; role: string }  // member of A and B
const userIds: string[] = []

async function makeUser(label: string, primary: string, memberOf: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${label}`,
      email: `${PREFIX}.${label}.${STAMP}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: 'admin',
      tenantId: primary,
      isActive: true,
      accountStatus: 'active',
      tenantMemberships: { create: memberOf.map((t) => ({ tenant: { connect: { id: t } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  userIds.push(u.id)
  return u as { id: string; name: string; email: string; role: string }
}

function auth(u: { id: string; name: string; email: string; role: string }, activeTenant?: string) {
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return {
    authorization: `Bearer ${s.accessToken}`,
    ...(activeTenant ? { 'x-servd-active-tenant': activeTenant } : {}),
  }
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Sep Co A', slug: `${PREFIX}-a-${STAMP}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Sep Co B', slug: `${PREFIX}-b-${STAMP}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  slugA = `${PREFIX}-brand-a-${STAMP}`
  slugB = `${PREFIX}-brand-b-${STAMP}`
  conceptA = (await prisma.concept.create({ data: { name: 'Sep Brand A', slug: slugA, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Sep Brand B', slug: slugB, type: 'restaurant', tenantId: tenantB } })).id
  catA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains A' } })).id
  catB = (await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains B' } })).id
  stationA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill A' } })).id
  stationB = (await prisma.station.create({ data: { conceptId: conceptB, name: 'Grill B' } })).id
  userA = await makeUser('a', tenantA, [tenantA])
  userB = await makeUser('b', tenantB, [tenantB])
  userHQ = await makeUser('hq', tenantA, [tenantA, tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[sepContent] 500:', err)
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(giftCardRoutes, { prefix: '/gift-cards' })
    await api.register(calendarRoutes, { prefix: '/calendar' })
    await api.register(mediaRoutes, { prefix: '/media' })
    await api.register(promoRoutes, { prefix: '/promos' })
    await api.register(parSheetRoutes, { prefix: '/par-sheet' })
    await api.register(menuRoutes, { prefix: '/menu' })
    await api.register(recipeRoutes, { prefix: '/recipes' })
    await api.register(storefrontRoutes, { prefix: '/storefront' })
    await api.register(expoRoutes, { prefix: '/expo' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  const tenants = [tenantA, tenantB]
  await prisma.recipe.deleteMany({ where: { OR: [{ name: { startsWith: PREFIX } }, { menuItem: { conceptId: { in: [conceptA, conceptB] } } }] } })
  await prisma.menuItem.deleteMany({ where: { conceptId: { in: [conceptA, conceptB] } } })
  await prisma.giftCardRedemption.deleteMany({ where: { giftCard: { tenantId: { in: tenants } } } })
  await prisma.giftCard.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.order.deleteMany({ where: { conceptId: { in: [conceptA, conceptB] } } })
  await prisma.promoCode.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.storefrontPromo.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.mediaAsset.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.contentEvent.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.inventoryItem.deleteMany({ where: { name: { startsWith: PREFIX } } })
  await prisma.station.deleteMany({ where: { conceptId: { in: [conceptA, conceptB] } } })
  await prisma.category.deleteMany({ where: { conceptId: { in: [conceptA, conceptB] } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined)
  await prisma.tenantMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
})

// ── Gift cards ───────────────────────────────────────────────────────────────

describe('gift cards (owner decision 14)', () => {
  let cardId: string
  let code: string
  let orderA: string
  let orderB: string

  beforeAll(async () => {
    const r = await call('POST', '/gift-cards', auth(userA), { issuedAmountCents: 50_000, paymentMethod: 'cash' })
    expect(r.statusCode).toBe(201)
    cardId = r.json().id
    code = r.json().code
    orderA = (await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', totalCents: 5_000 } })).id
    orderB = (await prisma.order.create({ data: { conceptId: conceptB, source: 'pos', totalCents: 5_000 } })).id
  })

  it('stamps the issuing company on a brand-less card', async () => {
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: cardId } })
    expect(card.tenantId).toBe(tenantA)
    expect(card.conceptId).toBeNull()
  })

  it('another company does not see it', async () => {
    const r = await call('GET', '/gift-cards', auth(userB))
    expect(r.statusCode).toBe(200)
    expect(r.json().map((c: { id: string }) => c.id)).not.toContain(cardId)
    const mine = await call('GET', '/gift-cards', auth(userA))
    expect(mine.json().map((c: { id: string }) => c.id)).toContain(cardId)
  })

  it("B cannot redeem A's card at B's till (404, balance untouched)", async () => {
    // A redemption is always against an order now (one engine, decision 14).
    const r = await call('POST', '/gift-cards/redeem', auth(userB), { code, amountCents: 1_000 })
    expect(r.statusCode).toBe(400)
    const r2 = await call('POST', '/gift-cards/redeem', auth(userB), { code, amountCents: 1_000, orderId: orderB })
    expect(r2.statusCode).toBe(404)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: cardId } })).balanceCents).toBe(50_000)
  })

  it("B cannot name A's order either", async () => {
    const r = await call('POST', '/gift-cards/redeem', auth(userB), { code, amountCents: 1_000, orderId: orderA })
    expect(r.statusCode).toBe(404)
  })

  it("a card never pays another company's order, even for a head-office user", async () => {
    const r = await call('POST', '/gift-cards/redeem', auth(userHQ), { code, amountCents: 1_000, orderId: orderB })
    expect(r.statusCode).toBe(404)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: cardId } })).balanceCents).toBe(50_000)
  })

  it('A redeems its own card against its own order', async () => {
    const r = await call('POST', '/gift-cards/redeem', auth(userA), { code, amountCents: 1_000, orderId: orderA })
    expect(r.statusCode).toBe(200)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: cardId } })).balanceCents).toBe(49_000)
  })

  it("B cannot void A's card", async () => {
    const r = await call('POST', `/gift-cards/${cardId}/void`, auth(userB), { reason: 'fraud test' })
    expect(r.statusCode).toBe(404)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: cardId } })).status).toBe('active')
  })

  it("B cannot issue a card under A's brand", async () => {
    const r = await call('POST', '/gift-cards', auth(userB), { issuedAmountCents: 20_000, conceptId: conceptA, paymentMethod: 'cash' })
    expect(r.statusCode).toBe(404)
  })
})

// ── Calendar ─────────────────────────────────────────────────────────────────

describe('marketing calendar', () => {
  let eventId: string

  beforeAll(async () => {
    const r = await call('POST', '/calendar', auth(userA), {
      title: 'A company-wide campaign', type: 'deal', startDate: new Date().toISOString(),
    })
    expect(r.statusCode).toBe(201)
    eventId = r.json().id
  })

  it("stamps the active company; a brand-less event is not every company's", async () => {
    expect((await prisma.contentEvent.findUniqueOrThrow({ where: { id: eventId } })).tenantId).toBe(tenantA)
    const r = await call('GET', '/calendar', auth(userB))
    expect(r.statusCode).toBe(200)
    expect(r.json().map((e: { id: string }) => e.id)).not.toContain(eventId)
    const mine = await call('GET', '/calendar', auth(userA))
    expect(mine.json().map((e: { id: string }) => e.id)).toContain(eventId)
  })

  it("B cannot edit, delete or post from A's event", async () => {
    expect((await call('PATCH', `/calendar/${eventId}`, auth(userB), { title: 'hijacked' })).statusCode).toBe(404)
    expect((await call('DELETE', `/calendar/${eventId}`, auth(userB))).statusCode).toBe(404)
    const post = await call('POST', `/calendar/${eventId}/social-post`, auth(userB), {
      platform: 'instagram', caption: 'x', scheduledFor: new Date().toISOString(),
    })
    expect(post.statusCode).toBe(404)
    const ev = await prisma.contentEvent.findUniqueOrThrow({ where: { id: eventId } })
    expect(ev.title).toBe('A company-wide campaign')
  })

  it("B cannot file an event under A's brand, or assign A's staff", async () => {
    const r = await call('POST', '/calendar', auth(userB), { title: 'x', type: 'deal', startDate: new Date().toISOString(), conceptId: conceptA })
    expect(r.statusCode).toBe(404)
    const r2 = await call('POST', '/calendar', auth(userB), { title: 'x', type: 'deal', startDate: new Date().toISOString(), assigneeId: userA.id })
    expect(r2.statusCode).toBe(422)
  })
})

// ── Media ────────────────────────────────────────────────────────────────────

describe('media library', () => {
  let assetA: string

  beforeAll(async () => {
    assetA = (await prisma.mediaAsset.create({
      data: { tenantId: tenantA, key: `${PREFIX}/a.jpg`, url: 'https://cdn.example/a.jpg', filename: 'a.jpg', contentType: 'image/jpeg' },
    })).id
  })

  it("B does not see A's assets and cannot delete them", async () => {
    const r = await call('GET', '/media', auth(userB))
    expect(r.statusCode).toBe(200)
    expect(r.json().data.map((a: { id: string }) => a.id)).not.toContain(assetA)
    expect((await call('DELETE', `/media/${assetA}`, auth(userB))).statusCode).toBe(404)
    expect(await prisma.mediaAsset.findUnique({ where: { id: assetA } })).not.toBeNull()
  })

  it('A sees and deletes its own', async () => {
    const r = await call('GET', '/media', auth(userA))
    expect(r.json().data.map((a: { id: string }) => a.id)).toContain(assetA)
    expect((await call('DELETE', `/media/${assetA}`, auth(userA))).statusCode).toBe(204)
  })
})

// ── Promo codes ──────────────────────────────────────────────────────────────

describe('promo codes', () => {
  let promoId: string
  const code = `SEPA${STAMP % 100000}`

  beforeAll(async () => {
    const r = await call('POST', '/promos', auth(userA), {
      code, discountType: 'percentage', discountValue: 100,
      startAt: new Date(Date.now() - 86_400_000).toISOString(), endAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(r.statusCode).toBe(201)
    promoId = r.json().id
  })

  it('stamps the company; brand-less means every brand of ITS company only', async () => {
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promoId } })).tenantId).toBe(tenantA)
    const r = await call('GET', '/promos', auth(userB))
    expect(r.json().map((p: { id: string }) => p.id)).not.toContain(promoId)
  })

  it("B cannot edit or delete A's promo", async () => {
    expect((await call('PATCH', `/promos/${promoId}`, auth(userB), { discountValue: 5 })).statusCode).toBe(404)
    expect((await call('DELETE', `/promos/${promoId}`, auth(userB))).statusCode).toBe(404)
  })

  it("A's code is not valid at B's brand, and is at A's", async () => {
    // /promos/validate is gone (one evaluation, lib/promoEval.ts); the public
    // preview looks a code up in the brand's company.
    const atB = await call('GET', `/storefront/promo-preview?code=${code}&conceptSlug=${slugB}`, {})
    expect(atB.json().valid).toBe(false)
    const atA = await call('GET', `/storefront/promo-preview?code=${code}&conceptSlug=${slugA}`, {})
    expect(atA.json().valid).toBe(true)
  })

  it('a promo cannot be created under, or moved to, a foreign brand', async () => {
    const r = await call('POST', '/promos', auth(userB), {
      code: `SEPB${STAMP % 100000}`, conceptId: conceptA, discountValue: 10,
      startAt: new Date().toISOString(), endAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(r.statusCode).toBe(404)
    const move = await call('PATCH', `/promos/${promoId}`, auth(userHQ), { conceptId: conceptB })
    expect(move.statusCode).toBe(422)
  })
})

// ── Storefront admin ─────────────────────────────────────────────────────────

describe('storefront deals strip + abandoned-cart metrics', () => {
  let stripA: string

  beforeAll(async () => {
    const r = await call('POST', '/storefront/admin/promos', auth(userA), { badge: 'A', headline: 'A deal', sub: 'only A' })
    expect(r.statusCode).toBe(201)
    stripA = r.json().id
  })

  it("B cannot see, edit or delete A's strip", async () => {
    const r = await call('GET', '/storefront/admin/promos', auth(userB))
    expect(r.json().map((p: { id: string }) => p.id)).not.toContain(stripA)
    expect((await call('PATCH', `/storefront/admin/promos/${stripA}`, auth(userB), { headline: 'x' })).statusCode).toBe(404)
    expect((await call('DELETE', `/storefront/admin/promos/${stripA}`, auth(userB))).statusCode).toBe(404)
    expect((await prisma.storefrontPromo.findUniqueOrThrow({ where: { id: stripA } })).headline).toBe('A deal')
  })

  it("abandoned-cart metrics refuse A's brand for B", async () => {
    expect((await call('GET', `/storefront/abandoned-carts/metrics?conceptId=${conceptA}`, auth(userB))).statusCode).toBe(404)
    expect((await call('GET', '/storefront/abandoned-carts/metrics', auth(userB))).statusCode).toBe(200)
  })
})

// ── Menu ─────────────────────────────────────────────────────────────────────

describe('menu items stay inside their brand', () => {
  let itemB: string

  beforeAll(async () => {
    const r = await call('POST', '/menu/items', auth(userB), { conceptId: conceptB, categoryId: catB, name: 'B burger', priceCents: 1000 })
    expect(r.statusCode).toBe(201)
    itemB = r.json().id
  })

  it("B cannot move its item into A's category or brand", async () => {
    const toCat = await call('PATCH', `/menu/items/${itemB}`, auth(userB), { categoryId: catA })
    expect(toCat.statusCode).toBe(422)
    const toBrand = await call('PATCH', `/menu/items/${itemB}`, auth(userB), { conceptId: conceptA })
    expect(toBrand.statusCode).toBe(422)
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: itemB } })
    expect(item.categoryId).toBe(catB)
    expect(item.conceptId).toBe(conceptB)
  })

  it('refused even for a head-office user who belongs to both companies', async () => {
    const r = await call('PATCH', `/menu/items/${itemB}`, auth(userHQ, tenantB), { categoryId: catA, stationId: stationA })
    expect(r.statusCode).toBe(422)
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: itemB } })).categoryId).toBe(catB)
  })

  it("stations must be the item's brand's; same-brand edits still work", async () => {
    expect((await call('PATCH', `/menu/items/${itemB}`, auth(userB), { stationId: stationA })).statusCode).toBe(422)
    const ok = await call('PATCH', `/menu/items/${itemB}`, auth(userB), { stationId: stationB, conceptId: conceptB, name: 'B burger 2' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().stationId).toBe(stationB)
  })

  it("an item cannot be created under a foreign category, and a category not under A's brand from B", async () => {
    expect((await call('POST', '/menu/items', auth(userB), { conceptId: conceptB, categoryId: catA, name: 'x', priceCents: 1 })).statusCode).toBe(422)
    expect((await call('POST', '/menu/categories', auth(userB), { conceptId: conceptA, name: 'x' })).statusCode).toBe(404)
  })
})

// ── Recipes ──────────────────────────────────────────────────────────────────

describe('recipes', () => {
  let componentA: string
  let plateA: string
  let stepA: string
  let pendingA: string

  beforeAll(async () => {
    const inv = await prisma.inventoryItem.create({ data: { name: `${PREFIX} onions`, unit: 'kg', unitCostCents: 20_000, tenantId: tenantA } })
    const itemA = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA, name: 'A plate', priceCents: 2000 } })
    componentA = (await prisma.recipe.create({
      data: { kind: 'component', name: `${PREFIX} A sauce`, yieldGrams: 1000,
        ingredients: { create: [{ inventoryItemId: inv.id, quantity: 1, unit: 'kg' }] } },
    })).id
    plateA = (await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: itemA.id,
        ingredients: { create: [{ prepRecipeId: componentA, quantity: 50, unit: 'g' }] } },
    })).id
    pendingA = (await prisma.recipe.create({
      data: { kind: 'plate', status: 'pending_approval', submittedAt: new Date(), name: `${PREFIX} pending A`,
        pendingMenuItem: { conceptId: conceptA, categoryId: catA, name: 'Pending A', description: null } },
    })).id
    stepA = (await prisma.recipeStep.create({ data: { recipeId: plateA, phase: 'service_cook', instruction: 'Sear' } })).id
  })

  it("B cannot read, edit or delete A's sub-recipe", async () => {
    expect((await call('GET', `/recipes/${componentA}`, auth(userB))).statusCode).toBe(404)
    expect((await call('PUT', `/recipes/${componentA}`, auth(userB), { notes: 'hijacked' })).statusCode).toBe(404)
    expect((await call('DELETE', `/recipes/${componentA}`, auth(userB))).statusCode).toBe(404)
    expect(await prisma.recipe.findUnique({ where: { id: componentA } })).not.toBeNull()
    expect((await call('GET', `/recipes/${componentA}`, auth(userA))).statusCode).toBe(200)
  })

  it("A's sub-recipes and pending approvals are not listed for B", async () => {
    const prep = await call('GET', '/par-sheet/preps?for=recipe', auth(userB))
    expect(prep.json().map((r: { id: string }) => r.id)).not.toContain(componentA)
    expect((await call('GET', '/par-sheet/preps?for=recipe', auth(userA))).json().map((r: { id: string }) => r.id)).toContain(componentA)
    const pending = await call('GET', '/recipes/pending-approval', auth(userB))
    expect(pending.json().map((r: { id: string }) => r.id)).not.toContain(pendingA)
    expect((await call('GET', '/recipes/pending-approval', auth(userA))).json().map((r: { id: string }) => r.id)).toContain(pendingA)
    const list = await call('GET', '/recipes', auth(userB))
    expect(list.json().map((r: { id: string }) => r.id)).not.toContain(componentA)
  })

  it("B cannot build its recipe from A's sub-recipe or stock", async () => {
    const r = await call('POST', '/recipes', auth(userB), {
      kind: 'component', name: `${PREFIX} B copy`, yieldGrams: 100,
      ingredients: [{ prepRecipeId: componentA, quantity: 10, unit: 'g' }],
    })
    expect(r.statusCode).toBe(422)
  })

  it("B cannot add, edit or delete A's recipe steps", async () => {
    expect((await call('POST', `/recipes/${plateA}/steps`, auth(userB), { phase: 'service_cook', instruction: 'x' })).statusCode).toBe(404)
    expect((await call('PATCH', `/recipes/steps/${stepA}`, auth(userB), { instruction: 'hijacked' })).statusCode).toBe(404)
    expect((await call('DELETE', `/recipes/steps/${stepA}`, auth(userB))).statusCode).toBe(404)
    expect((await prisma.recipeStep.findUniqueOrThrow({ where: { id: stepA } })).instruction).toBe('Sear')
  })

  it("a step's station must be the recipe's company's", async () => {
    expect((await call('PATCH', `/recipes/steps/${stepA}`, auth(userHQ), { stationId: stationB })).statusCode).toBe(422)
    const ok = await call('PATCH', `/recipes/steps/${stepA}`, auth(userA), { stationId: stationA })
    expect(ok.statusCode).toBe(200)
  })
})

// ── Expo ─────────────────────────────────────────────────────────────────────

describe('expo', () => {
  it('bumping an unknown or foreign step is 404, not 403', async () => {
    const r = await call('POST', '/expo/steps/00000000-0000-4000-8000-000000000000/bump', auth(userB))
    expect(r.statusCode).toBe(404)
  })
})
