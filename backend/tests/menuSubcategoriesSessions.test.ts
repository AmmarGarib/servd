// Sub-categories and sales sessions (owner, 2026-10-22: "Yes, add
// sub-categories and sessions"; sessions per brand, a separate list from the
// reservation dayparts).
//   - a sub-category sits under ONE main category of the same brand (one level);
//     another brand's / company's category as parent → 422; a category with
//     sub-categories cannot be deleted (409) or put under another
//   - sessions: per brand, no overlap among active ones (midnight crossing
//     counted), no duplicate live name; switched off, not deleted
//   - company separation: company B gets 404 on company A's sessions and
//     brand; a new session binds to the brand's company
//   - reports: Category = the main category, Sub category = the item's own;
//     the categories filter takes in sub-categories; sessions filter by the
//     Karachi time the bill was placed; Sales Detail shows the session;
//     Cashier Sales Detail breaks down by session and sub category
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { menuRoutes } from '../src/modules/menu/routes.js'
import { tillReportRoutes } from '../src/modules/reports/tillReportsRoutes.js'

const P = `mss${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const C: Record<string, string> = {}
const tok: Record<string, string> = {}
const U: Record<string, string> = {}
const K: Record<string, string> = {}
const M: Record<string, string> = {}
const O: string[] = []
const DAY = '2026-10-21'
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00.000+05:00`)

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@mss.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  U[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${tok[who]}` } })
const run = (id: string, qs = '') => call('mgrA', 'GET', `/reports/till/run/${id}?conceptIds=${C.A}&dateFrom=${DAY}&dateTo=${DAY}${qs}`)
type Section = { title: string | null; rows: Array<Record<string, unknown>> }
const sectionsOf = (r: { json: () => unknown }) => (r.json() as { sections: Section[] }).sections

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'MSS A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'MSS B', slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} A`, slug: `${P}-ca`, type: 'restaurant', tenantId: T.A } })).id
  C.A2 = (await prisma.concept.create({ data: { name: `${P} A2`, slug: `${P}-ca2`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} B`, slug: `${P}-cb`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('mgrA', 'manager', T.A)
  await mkUser('mgrB', 'manager', T.B)
  K.burgers = (await prisma.category.create({ data: { conceptId: C.A!, name: 'Burgers' } })).id
  K.drinks = (await prisma.category.create({ data: { conceptId: C.A!, name: 'Drinks' } })).id
  K.otherBrand = (await prisma.category.create({ data: { conceptId: C.A2!, name: 'Other brand' } })).id
  K.bCat = (await prisma.category.create({ data: { conceptId: C.B!, name: 'B cat' } })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(menuRoutes, { prefix: '/menu' })
  await app.register(tillReportRoutes, { prefix: '/reports/till' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { orderId: { in: O } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: O } } })
  await prisma.order.deleteMany({ where: { id: { in: O } } })
  await prisma.menuItem.deleteMany({ where: { id: { in: Object.values(M) } } })
  await prisma.category.updateMany({ where: { conceptId: { in: Object.values(C) } }, data: { parentId: null } })
  await prisma.category.deleteMany({ where: { conceptId: { in: Object.values(C) } } })
  await prisma.menuSession.deleteMany({ where: { conceptId: { in: Object.values(C) } } })
  await app?.close()
})

describe('sub-categories', () => {
  it('a sub-category sits under a main category of the same brand', async () => {
    const r = await call('mgrA', 'POST', '/menu/categories', { conceptId: C.A, name: 'Beef', parentId: K.burgers })
    expect(r.statusCode, r.body).toBe(201)
    K.beef = r.json().id
    expect(r.json().parentId).toBe(K.burgers)
    K.chicken = (await call('mgrA', 'POST', '/menu/categories', { conceptId: C.A, name: 'Chicken', parentId: K.burgers })).json().id
  })

  it('refuses another brand’s or company’s parent, a sub-category as parent, itself, and nesting a parent', async () => {
    expect((await call('mgrA', 'POST', '/menu/categories', { conceptId: C.A, name: 'X', parentId: K.otherBrand })).json().error.code).toBe('PARENT_NOT_IN_BRAND')
    expect((await call('mgrA', 'POST', '/menu/categories', { conceptId: C.A, name: 'X', parentId: K.bCat })).json().error.code).toBe('PARENT_NOT_IN_BRAND')
    expect((await call('mgrA', 'POST', '/menu/categories', { conceptId: C.A, name: 'X', parentId: K.beef })).json().error.code).toBe('PARENT_IS_SUBCATEGORY')
    expect((await call('mgrA', 'PATCH', `/menu/categories/${K.drinks}`, { parentId: K.drinks })).json().error.code).toBe('PARENT_IS_SELF')
    expect((await call('mgrA', 'PATCH', `/menu/categories/${K.burgers}`, { parentId: K.drinks })).json().error.code).toBe('CATEGORY_HAS_SUBCATEGORIES')
    // Company B cannot touch company A's category, nor use it as a parent.
    expect((await call('mgrB', 'PATCH', `/menu/categories/${K.beef}`, { parentId: null })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', '/menu/categories', { conceptId: C.B, name: 'X', parentId: K.burgers })).json().error.code).toBe('PARENT_NOT_IN_BRAND')
  })

  it('a main category with sub-categories cannot be deleted', async () => {
    const r = await call('mgrA', 'DELETE', `/menu/categories/${K.burgers}`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('CATEGORY_HAS_SUBCATEGORIES')
  })

  it('moving back to the top level works', async () => {
    const r = await call('mgrA', 'PATCH', `/menu/categories/${K.chicken}`, { parentId: null })
    expect(r.statusCode).toBe(200)
    expect(r.json().parentId).toBeNull()
    await call('mgrA', 'PATCH', `/menu/categories/${K.chicken}`, { parentId: K.burgers })
  })
})

describe('sessions', () => {
  it('creates per brand, bound to the brand’s company; refuses overlaps (midnight counted) and duplicate names', async () => {
    const b = await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Breakfast', startTime: '08:00', endTime: '11:00' })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json().tenantId).toBe(T.A)
    K.sBreakfast = b.json().id
    const d = await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Dinner', startTime: '18:00', endTime: '02:00' })
    expect(d.statusCode).toBe(201)
    K.sDinner = d.json().id
    expect((await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Late', startTime: '01:00', endTime: '03:00' })).json().error.code).toBe('SESSION_OVERLAP')
    expect((await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Brunch', startTime: '10:30', endTime: '12:00' })).json().error.code).toBe('SESSION_OVERLAP')
    expect((await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'breakfast', startTime: '12:00', endTime: '13:00' })).statusCode).toBe(409)
    expect((await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'X', startTime: '25:00', endTime: '13:00' })).statusCode).toBe(400)
    // Another brand may use the same times.
    expect((await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A2, name: 'Breakfast', startTime: '08:00', endTime: '11:00' })).statusCode).toBe(201)
  })

  it('switched off, not deleted; a switched-off session frees its times', async () => {
    const lunch = (await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Lunch', startTime: '12:00', endTime: '16:00' })).json()
    const off = await call('mgrA', 'PATCH', `/menu/sessions/${lunch.id}`, { isActive: false })
    expect(off.json().isActive).toBe(false)
    expect((await call('mgrA', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Lunch', startTime: '12:00', endTime: '17:00' })).statusCode).toBe(201)
    // Switching the old one back on clashes with the new one (same name, overlapping times).
    expect((await call('mgrA', 'PATCH', `/menu/sessions/${lunch.id}`, { isActive: true })).json().error.code).toBe('SESSION_NAME_TAKEN')
    expect((await call('mgrA', 'PATCH', `/menu/sessions/${lunch.id}`, { isActive: true, name: 'Old lunch' })).json().error.code).toBe('SESSION_OVERLAP')
  })

  it('company B: 404 on company A’s sessions and brand', async () => {
    expect((await call('mgrB', 'GET', `/menu/sessions?conceptId=${C.A}`)).statusCode).toBe(404)
    expect((await call('mgrB', 'PATCH', `/menu/sessions/${K.sBreakfast}`, { name: 'Mine' })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', '/menu/sessions', { conceptId: C.A, name: 'Mine', startTime: '05:00', endTime: '06:00' })).statusCode).toBe(404)
    const list = (await call('mgrA', 'GET', `/menu/sessions?conceptId=${C.A}`)).json() as Array<{ name: string }>
    expect(list.map((s) => s.name)).toEqual(expect.arrayContaining(['Breakfast', 'Dinner', 'Lunch']))
  })
})

describe('reports', () => {
  beforeAll(async () => {
    M.beefBurger = (await prisma.menuItem.create({ data: { conceptId: C.A!, categoryId: K.beef!, name: 'Beef Burger', priceCents: 1000_00 } })).id
    M.chickenBurger = (await prisma.menuItem.create({ data: { conceptId: C.A!, categoryId: K.chicken!, name: 'Chicken Burger', priceCents: 800_00 } })).id
    M.cola = (await prisma.menuItem.create({ data: { conceptId: C.A!, categoryId: K.drinks!, name: 'Cola', priceCents: 200_00 } })).id
    const mk = async (placed: string, items: Array<[string, string, number]>) => {
      const total = items.reduce((s, [, , p]) => s + p, 0)
      const o = await prisma.order.create({
        data: {
          conceptId: C.A!, source: 'pos', externalId: `${P}-${O.length}`, status: 'completed', placedAt: at(placed), completedAt: at(placed), totalCents: total,
          items: { create: items.map(([m, name, price]) => ({ menuItemId: m, name, quantity: 1, unitPriceCents: price })) },
        } as never,
      })
      O.push(o.id)
      await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: total, status: 'paid', processedAt: at(placed) } })
    }
    await mk('09:00', [[M.beefBurger!, 'Beef Burger', 1000_00]]) // Breakfast
    await mk('19:30', [[M.chickenBurger!, 'Chicken Burger', 800_00], [M.cola!, 'Cola', 200_00]]) // Dinner
    await mk('00:30', [[M.cola!, 'Cola', 200_00]]) // Dinner (past midnight, the same Karachi day's 00:30)
    await mk('16:30', [[M.cola!, 'Cola', 200_00]]) // Lunch (12:00–17:00)
    await mk('17:30', [[M.cola!, 'Cola', 200_00]]) // no session
  })

  it('lookups list main categories, sub-categories and the brand’s active sessions', async () => {
    const l = (await call('mgrA', 'GET', `/reports/till/lookups?conceptIds=${C.A}`)).json()
    expect(l.categories.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['Burgers', 'Drinks']))
    expect(l.categories.map((c: { name: string }) => c.name)).not.toContain('Beef')
    expect(l.subCategories.map((c: { name: string; parentId: string }) => [c.name, c.parentId])).toEqual(expect.arrayContaining([['Beef', K.burgers], ['Chicken', K.burgers]]))
    expect(l.sessions.map((s: { name: string }) => s.name).sort()).toEqual(['Breakfast', 'Dinner', 'Lunch'])
    // Company B sees nothing of A's brand.
    expect((await call('mgrB', 'GET', `/reports/till/lookups?conceptIds=${C.A}`)).statusCode).toBe(404)
  })

  it('Menu Item Sales Summary: category = the main one, sub category beside the item; the category filter takes in its subs', async () => {
    const r = await run('menu_item_sales_summary', `&categories=${K.burgers}`)
    expect(r.statusCode, r.body).toBe(200)
    const s = sectionsOf(r)
    const burgers = s.find((x) => x.title === 'Burgers')!
    expect(burgers.rows.map((x) => [x.item, x.subCategory])).toEqual(expect.arrayContaining([['Beef Burger', 'Beef'], ['Chicken Burger', 'Chicken']]))
    expect(s.find((x) => x.title === 'Drinks')).toBeUndefined()
    const sub = sectionsOf(await run('menu_item_sales_summary', `&subCategories=${K.beef}`))
    expect(sub.find((x) => x.title === 'Burgers')!.rows.map((x) => x.item)).toEqual(['Beef Burger'])
  })

  it('sessions filter by the Karachi time the bill was placed (midnight crossing included); Sales Detail names it', async () => {
    const d = sectionsOf(await run('sales_detail', `&sessions=${K.sDinner}`))[0]!
    expect(d.rows.map((x) => x.session)).toEqual(['Dinner', 'Dinner'])
    const all = sectionsOf(await run('sales_detail'))[0]!
    expect(all.rows.map((x) => x.session).sort()).toEqual(['Breakfast', 'Dinner', 'Dinner', 'Lunch', 'No session'])
  })

  it('Cashier Sales Detail breaks down by session and by sub category', async () => {
    const s = sectionsOf(await run('cashier_sales_detail', '&opts=session,subCategory'))
    const sess = s.find((x) => x.title === 'Session Summary')!.rows.map((x) => [x.line, x.count])
    expect(sess).toEqual([['Breakfast', 1], ['Dinner', 2], ['Lunch', 1], ['No session', 1]])
    const subs = s.find((x) => x.title === 'Sub Category Summary')!.rows.map((x) => x.line)
    expect(subs).toEqual(expect.arrayContaining(['Burgers › Beef', 'Burgers › Chicken', 'Drinks (no sub category)']))
  })

  it('Category Wise Tax Collection splits by sub category when ticked', async () => {
    const rows = sectionsOf(await run('category_tax_collection', '&opts=subCategory,includeNoCharge'))[0]!.rows
    expect(rows.map((x) => [x.category, x.subCategory])).toEqual(expect.arrayContaining([['Burgers', 'Beef'], ['Burgers', 'Chicken'], ['Drinks', '—']]))
  })
})
