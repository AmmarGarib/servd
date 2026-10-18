// Wave 3 (stream E) — the sidebar and the server agree on the live-operations
// reads, the brand picker and the operational reports.
//
//   UI-12  IT / marketing read the live order pipeline and the refundable-
//          orders list; every role read the rider roster, the dispatch board
//          and the expo queue; boh_management read /crm/customers. Now
//          /orders, /expo, /dispatch, /riders and /crm are module-gated
//          (lib/moduleAccess.ts GATED_PREFIXES) with every module whose pages
//          use them — the till and KDS roles keep what they use.
//   UI-13  the shell's brand picker 403'd for every non-manager role; it reads
//          GET /concepts?view=picker now — any staff role, own companies only.
//   UI-15  foh_management / boh_management hold 'reports' but /reports/sales
//          was FINANCIALS_VIEWERS; the operational reports are open to the
//          roles holding 'reports', per company.
//   Wave B (2026-10-14) Reports → Food cost variance (/reports/food-cost) is
//          its own module, food_cost — the 'reports' module does not open it;
//          GET also answers the accounting module (the Accounting hub's gauge).
//
// Every widened route is checked across two companies: company B's role sees
// nothing of company A's.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendWhatsApp: vi.fn(async () => ({ ok: true })) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { issueRiderSession } = await import('../src/modules/riderAuth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ALL_ROLES } = await import('../src/lib/roles.js')
const { DEFAULT_MODULE_ACCESS, enforceModuleAccess, invalidateModuleAccessCache, MODULE_GRANTS, rolesGrantedByDefault } = await import('../src/lib/moduleAccess.js')
const { FINANCE_TEAM } = await import('../src/modules/auth/middleware.js')
const { orderRoutes, orderCourseRoutes } = await import('../src/modules/orders/routes.js')
const { riderRoutes } = await import('../src/modules/riders/routes.js')
const { dispatchRoutes } = await import('../src/modules/dispatch/routes.js')
const { expoRoutes } = await import('../src/modules/expo/routes.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { reportRoutes } = await import('../src/modules/reports/routes.js')
const { default: foodCostRoutes } = await import('../src/modules/reports/foodCostRoutes.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { riderAppRoutes } = await import('../src/modules/rider/routes.js')
const { timeClockRoutes } = await import('../src/modules/timeclock/routes.js')
const { kdsRoutes } = await import('../src/modules/kds/routes.js')
const { parSheetRoutes } = await import('../src/modules/par-sheet/routes.js')
const { crosschecksRoutes } = await import('../src/modules/crosschecks/routes.js')
// The admin's page guard (AppShell PageGuard → canOpenPath). Pure functions;
// its only import is a type, so it loads here as-is.
const { canOpenPath, pagesForModules } = await import('../../frontend/admin/src/lib/moduleCatalog.ts')

const RUN = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let customerA: string
let riderA: string, riderB: string
let orderA: string
let riderToken: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: { moduleAllow?: string[]; moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@w3gates.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId,
      moduleAllow: extra.moduleAllow ?? [], moduleDeny: extra.moduleDeny ?? [],
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const get = (who: string, url: string) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: tokens[who]! } })

const holds = (role: string, m: string) => role === 'admin' || (DEFAULT_MODULE_ACCESS[role as UserRole] ?? []).includes(m)

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (w3e)', slug: `gs-w3e-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (w3e)', slug: `kb-w3e-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd W3', slug: `w3e-a-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Viva W3', slug: `w3e-b-${RUN}`, type: 'restaurant', tenantId: tenantB } })).id

  const categoryA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Coffee' } })).id
  const latteId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Latte', priceCents: 120_000 } })).id
  customerA = (await prisma.customer.create({ data: { name: 'Sana W3', phone: `+92300${String(RUN).slice(-7)}`, email: `sana.${RUN}@w3gates.test` } })).id
  orderA = (await prisma.order.create({
    data: {
      conceptId: conceptA, customerId: customerA, source: 'pos', status: 'completed', totalCents: 120_000, completedAt: new Date(),
      items: { create: [{ menuItemId: latteId, name: 'Latte', quantity: 1, unitPriceCents: 120_000 }] },
    } as never,
  })).id
  await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', status: 'ready', totalCents: 50_000, fulfilmentType: 'delivery' } as never })

  riderA = (await prisma.rider.create({ data: { tenantId: tenantA, name: 'Rider A', phone: `+92311${String(RUN).slice(-7)}`, status: 'available', isActive: true } })).id
  const rb = await prisma.rider.create({ data: { tenantId: tenantB, name: 'Rider B', phone: `+92312${String(RUN).slice(-7)}`, status: 'available', isActive: true } })
  riderB = rb.id
  riderToken = `Bearer ${issueRiderSession(rb).accessToken}`

  for (const role of ALL_ROLES) await mkUser(role, role, tenantA)
  for (const role of ['foh_management', 'kitchen', 'cashier', 'marketing', 'boh_management', 'finance'] as const) await mkUser(`${role}B`, role, tenantB)
  await mkUser('itAllowed', 'it', tenantA, { moduleAllow: ['orders'] })
  await mkUser('cashierDenied', 'cashier', tenantA, { moduleDeny: ['orders', 'pos', 'curbside'] })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const e = err as { statusCode?: number; code?: string; message: string }
    return reply.status(e.statusCode ?? 500).send({ error: { code: e.code ?? 'INTERNAL', message: e.message } })
  })
  await app.register(async (api) => {
    await api.register(orderRoutes, { prefix: '/orders' })
    await api.register(orderCourseRoutes, { prefix: '/orders' })
    await api.register(riderRoutes, { prefix: '/riders' })
    await api.register(dispatchRoutes, { prefix: '/dispatch' })
    await api.register(expoRoutes, { prefix: '/expo' })
    await api.register(crmRoutes, { prefix: '/crm' })
    // Registered BEFORE reportRoutes, as index.ts does (wave Z).
    await api.register(foodCostRoutes, { prefix: '/reports/food-cost' })
    await api.register(reportRoutes, { prefix: '/reports' })
    await api.register(conceptRoutes, { prefix: '/concepts' })
    await api.register(riderAppRoutes, { prefix: '/rider' })
    await api.register(timeClockRoutes, { prefix: '/time-clock' })
    await api.register(kdsRoutes, { prefix: '/kds' })
    await api.register(parSheetRoutes, { prefix: '/par-sheet' })
    await api.register(crosschecksRoutes, { prefix: '/crosschecks' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 90_000)

afterAll(async () => {
  await prisma.roleModuleAccess.deleteMany({ where: { role: 'brand_manager' } })
  invalidateModuleAccessCache()
  await app?.close()
})

describe('UI-12 live-operations reads are module-gated', () => {
  it('IT and marketing no longer read the order pipeline or the refundable-orders list', async () => {
    for (const role of ['it', 'marketing', 'brand_manager', 'hr', 'procurement']) {
      expect((await get(role, '/orders?status=received,confirmed,preparing,ready')).statusCode, `${role} pipeline`).toBe(403)
      expect((await get(role, '/orders?status=completed,preparing,received,confirmed,ready&limit=100')).statusCode, `${role} refunds list`).toBe(403)
      expect((await get(role, `/orders/${orderA}`)).statusCode, `${role} order`).toBe(403)
    }
  })

  it('boh_management no longer reads the CRM customer list or a profile', async () => {
    expect((await get('boh_management', '/crm/customers?search=&limit=50')).statusCode).toBe(403)
    expect((await get('boh_management', `/crm/customers/${customerA}`)).statusCode).toBe(403)
    expect((await get('boh_management', `/crm/customers/${customerA}/context`)).statusCode).toBe(403)
  })

  it('a role without dispatch / riders is refused the roster and the board', async () => {
    for (const role of ['cashier', 'kitchen', 'boh', 'expediter', 'boh_management', 'finance', 'hr', 'it', 'marketing', 'procurement']) {
      expect((await get(role, '/riders')).statusCode, `${role} /riders`).toBe(403)
      expect((await get(role, '/dispatch/board')).statusCode, `${role} /dispatch/board`).toBe(403)
    }
    for (const role of ['cashier', 'foh', 'finance', 'hr', 'it', 'marketing', 'procurement']) {
      expect((await get(role, '/expo/queue')).statusCode, `${role} /expo/queue`).toBe(403)
    }
  })

  it('every role reaches each gated read exactly when its defaults hold a module behind it', async () => {
    const READS: Array<{ path: string; modules: string[] }> = [
      { path: '/orders?status=received,confirmed,preparing,ready', modules: ['orders', 'refunds', 'curbside', 'pos', 'kds_dashboard', 'kds_all', 'expo_station', 'riders', 'dispatch'] },
      { path: '/expo/queue', modules: ['expo_station', 'kds_dashboard', 'kds_all'] },
      { path: '/dispatch/board', modules: ['dispatch', 'riders'] },
      { path: '/riders', modules: ['riders'] },
    ]
    const mismatches: string[] = []
    for (const role of ALL_ROLES) {
      for (const r of READS) {
        const expected = r.modules.some((m) => holds(role, m)) ? 200 : 403
        const got = (await get(role, r.path)).statusCode
        if (got !== expected) mismatches.push(`${role} ${r.path} → ${got} (want ${expected})`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('the till and KDS roles still read what they use', async () => {
    // Till (cashier, foh): its open-orders list and an order.
    for (const role of ['cashier', 'foh']) {
      expect((await get(role, `/orders?conceptId=${conceptA}&source=pos&limit=100`)).statusCode, `${role} till list`).toBe(200)
      expect((await get(role, `/orders/${orderA}`)).statusCode, `${role} order`).toBe(200)
      expect((await get(role, '/orders/curbside')).statusCode, `${role} curbside`).toBe(200)
    }
    // KDS / expo (kitchen, boh, expediter): the expo queue and an order.
    for (const role of ['kitchen', 'boh', 'expediter', 'boh_management']) {
      expect((await get(role, '/expo/queue')).statusCode, `${role} expo`).toBe(200)
      expect((await get(role, `/orders/${orderA}`)).statusCode, `${role} order`).toBe(200)
    }
    // FOH dispatch + rider roster.
    expect((await get('foh', '/dispatch/board')).statusCode).toBe(200)
    expect((await get('foh_management', '/riders')).statusCode).toBe(200)
    expect((await get('foh_management', '/dispatch/board')).statusCode).toBe(200)
    // The host's guest panel on Reservations (foh holds reservations, not crm).
    expect((await get('foh', `/crm/customers/${customerA}/context`)).statusCode).toBe(200)
    // Marketing keeps the CRM.
    expect((await get('marketing', '/crm/customers?search=&limit=50')).statusCode).toBe(200)
    expect((await get('marketing', '/crm/campaigns')).statusCode).toBe(200)
  })

  it('company separation holds for the roles still let in', async () => {
    // B's managers see none of A's riders, orders or customers.
    const roster = (await get('foh_managementB', '/riders')).json() as Array<{ id: string }> | { data: Array<{ id: string }> }
    const ids = (Array.isArray(roster) ? roster : roster.data).map((r) => r.id)
    expect(ids).toContain(riderB)
    expect(ids).not.toContain(riderA)
    expect((await get('foh_managementB', `/riders/${riderA}/history`)).statusCode).toBe(404)
    expect((await get('cashierB', `/orders/${orderA}`)).statusCode).toBe(404)
    expect((await get('kitchenB', `/orders/${orderA}`)).statusCode).toBe(404)
    const list = (await get('marketingB', '/crm/customers?search=&limit=50')).json() as { data: Array<{ id: string }> }
    expect(list.data.map((c) => c.id)).not.toContain(customerA)
    expect((await get('foh_managementB', `/crm/customers/${customerA}/context`)).statusCode).toBe(404)
  })

  it('a CEO Module Access override opens the gate, and a deny closes it', async () => {
    // Role override (the CEO's matrix): brand_manager + riders.
    expect((await get('brand_manager', '/riders')).statusCode).toBe(403)
    await prisma.roleModuleAccess.upsert({
      where: { role: 'brand_manager' },
      create: { role: 'brand_manager', modules: [...DEFAULT_MODULE_ACCESS.brand_manager, 'riders'] },
      update: { modules: [...DEFAULT_MODULE_ACCESS.brand_manager, 'riders'] },
    })
    invalidateModuleAccessCache()
    expect((await get('brand_manager', '/riders')).statusCode).toBe(200)
    await prisma.roleModuleAccess.deleteMany({ where: { role: 'brand_manager' } })
    invalidateModuleAccessCache()
    expect((await get('brand_manager', '/riders')).statusCode).toBe(403)

    // Per-user allow / deny.
    expect((await get('itAllowed', `/orders/${orderA}`)).statusCode).toBe(200)
    expect((await get('cashierDenied', `/orders/${orderA}`)).statusCode).toBe(403)
    await expect(enforceModuleAccess('/api/v1/crm/customers', { role: 'boh_management', moduleAllow: ['crm'] })).resolves.toBeUndefined()
  })

  it('never touches the rider app (/rider*) or the till / KDS writers outside the gated prefixes', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/v1/rider/me', headers: { authorization: riderToken } })
    expect(me.statusCode).toBe(200)
    // Path matching: /rider/… and /order-items/… are not /riders or /orders.
    await expect(enforceModuleAccess('/api/v1/rider/jobs', { role: 'it' })).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/order-items/x/status', { role: 'it' })).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/pos/orders', { role: 'it' })).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/riders', { role: 'it' })).rejects.toThrow(/module/)
  })
})

describe('UI-13 the brand picker works for every role, inside its own companies', () => {
  it('every staff role reads its own companies\' active brands with ?view=picker', async () => {
    // A director (owner, 2026-10-18) reads only GET /director/* — refused here.
    expect((await get('director', '/concepts?view=picker')).statusCode).toBe(403)
    for (const role of ALL_ROLES.filter((r) => r !== 'director')) {
      const r = await get(role, '/concepts?view=picker')
      expect(r.statusCode, role).toBe(200)
      const rows = r.json() as Array<Record<string, unknown>>
      expect(rows.map((c) => c.id), role).toContain(conceptA)
      expect(rows.map((c) => c.id), role).not.toContain(conceptB)
      // Narrow fields only — no tax, legal, POS ids or layout.
      for (const c of rows) expect(Object.keys(c).sort(), role).toEqual(['id', 'logoUrl', 'name', 'primaryColor', 'slug', 'tenantId'])
    }
    const b = (await get('kitchenB', '/concepts?view=picker')).json() as Array<{ id: string }>
    expect(b.map((c) => c.id)).toEqual([conceptB])
  })

  it('the plain brand list keeps its gate', async () => {
    expect((await get('kitchen', '/concepts')).statusCode).toBe(403)
    expect((await get('cashier', '/concepts')).statusCode).toBe(200)
  })
})

describe('UI-15 the operational reports follow the Reports module', () => {
  const range = 'dateFrom=2026-01-01&dateTo=2026-12-31'
  it('every role holding reports reads sales, item mix, stations and channels; others 403', async () => {
    const mismatches: string[] = []
    for (const role of ALL_ROLES) {
      const expected = holds(role, 'reports') ? 200 : 403
      for (const p of ['/reports/sales', '/reports/top-items', '/reports/stations', '/reports/by-source']) {
        const got = (await get(role, `${p}?${range}`)).statusCode
        if (got !== expected) mismatches.push(`${role} ${p} → ${got} (want ${expected})`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('foh/boh managers see their own company\'s sales only', async () => {
    const a = (await get('foh_management', `/reports/sales?${range}`)).json() as { totals: { orders: number } }
    const b = (await get('foh_managementB', `/reports/sales?${range}`)).json() as { totals: { orders: number } }
    expect(a.totals.orders).toBeGreaterThanOrEqual(1)
    expect(b.totals.orders).toBe(0)
    expect((await get('boh_managementB', `/reports/sales?conceptId=${conceptA}&${range}`)).statusCode).toBe(404)
  })

  it('company revenue stays with FINANCIALS_VIEWERS: the floor managers get volumes', async () => {
    const floor = (await get('foh_management', `/reports/sales?${range}`)).json() as { volumeOnly?: boolean; totals: Record<string, unknown>; byHour: Record<string, Record<string, unknown>> }
    expect(floor.volumeOnly).toBe(true)
    expect(Object.keys(floor.totals)).toEqual(['orders'])
    for (const h of Object.values(floor.byHour)) expect(Object.keys(h)).toEqual(['orders'])
    const fin = (await get('finance', `/reports/sales?${range}`)).json() as { volumeOnly?: boolean; totals: { gross: number } }
    expect(fin.volumeOnly).toBeUndefined()
    expect(fin.totals.gross).toBe(120_000)
    const ch = (await get('boh_management', `/reports/by-source?${range}`)).json() as Array<Record<string, unknown>>
    for (const r of ch) expect(Object.keys(r).sort()).toEqual(['orders', 'source'])
    const finCh = (await get('finance', `/reports/by-source?${range}`)).json() as Array<Record<string, unknown>>
    expect(finCh.some((r) => 'gross' in r)).toBe(true)
    // Item revenue: managers and finance as before; procurement gets quantities.
    const procItems = (await get('procurement', `/reports/top-items?${range}`)).json() as Array<Record<string, unknown>>
    expect(procItems.length).toBeGreaterThan(0)
    for (const i of procItems) expect('revenueCents' in i).toBe(false)
    const mgrItems = (await get('foh_management', `/reports/top-items?${range}`)).json() as Array<Record<string, unknown>>
    expect(mgrItems.every((i) => 'revenueCents' in i)).toBe(true)
    expect((await get('boh_managementB', `/reports/top-items?conceptId=${conceptA}&${range}`)).statusCode).toBe(404)
  })

  it('margin quadrants stay off the floor-only roles; finance reads them for the Accounting page', async () => {
    expect((await get('finance', `/reports/menu-engineering?conceptId=${conceptA}`)).statusCode).toBe(200)
    expect((await get('financeB', `/reports/menu-engineering?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await get('procurement', `/reports/menu-engineering?conceptId=${conceptA}`)).statusCode).toBe(403)
    expect((await get('cashier', `/reports/sales?${range}`)).statusCode).toBe(403)
  })
})

describe('wave B: Reports → Food cost variance follows the food_cost module', () => {
  it('every role: 200 when it is in the finance team and holds food_cost (reads: or accounting), else 403', async () => {
    const mismatches: string[] = []
    for (const role of ALL_ROLES) {
      const expected = FINANCE_TEAM.includes(role as UserRole) && (holds(role, 'food_cost') || holds(role, 'accounting')) ? 200 : 403
      const got = (await get(role, '/reports/food-cost/summary')).statusCode
      if (got !== expected) mismatches.push(`${role} → ${got} (want ${expected})`)
    }
    expect(mismatches).toEqual([])
    // Holding 'reports' alone never opens it (foh_management, procurement).
    expect((await get('foh_management', '/reports/food-cost/summary')).statusCode).toBe(403)
    expect((await get('procurement', '/reports/food-cost/summary')).statusCode).toBe(403)
    expect((await get('procurement', '/reports/sales')).statusCode).toBe(200)
  })

  it('the gate row: food_cost writes, accounting reads too; it sits before /reports', async () => {
    const url = '/api/v1/reports/food-cost/summary'
    await expect(enforceModuleAccess(url, { role: 'foh_management' }, 'GET')).rejects.toThrow(/food_cost/)
    await expect(enforceModuleAccess(url, { role: 'finance', moduleDeny: ['food_cost'] }, 'GET')).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/reports/food-cost/align-inventory', { role: 'finance', moduleDeny: ['food_cost'] }, 'POST')).rejects.toThrow()
    await expect(enforceModuleAccess(url, { role: 'boh_management', moduleDeny: ['food_cost'] }, 'GET')).rejects.toThrow()
  })

  it('company B never reads company A\'s food cost', async () => {
    expect((await get('financeB', `/reports/food-cost/summary?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await get('boh_managementB', `/reports/food-cost/valuation?tenantId=${tenantA}`)).statusCode).toBe(404)
    const b = (await get('financeB', '/reports/food-cost/summary')).json() as { companies: Array<{ tenantId: string }> }
    expect(b.companies.map((c) => c.tenantId)).toEqual([tenantB])
  })

  it('the page guard and MODULE_GRANTS agree with the API', () => {
    for (const role of ALL_ROLES) {
      const mods = DEFAULT_MODULE_ACCESS[role as UserRole] ?? []
      expect(canOpenPath('/reports/food-cost', role, mods), role).toBe(role === 'admin' || mods.includes('food_cost'))
    }
    expect(MODULE_GRANTS).toContain('food_cost')
    expect(rolesGrantedByDefault('food_cost')).toEqual(expect.arrayContaining(['fnb_manager', 'boh_management', 'finance']))
    expect(rolesGrantedByDefault('food_cost')).not.toContain('foh_management')
  })
})

// ── Review fixes (W3E-RV-1 / 2 / 4 / 5) ─────────────────────────────────────
describe('W3E-RV the page guard opens every page a role\'s work needs', () => {
  const mods = (role: string) => DEFAULT_MODULE_ACCESS[role as UserRole] ?? []
  const open = (role: string, path: string) => canOpenPath(path, role, mods(role))

  it('every page in a role\'s sidebar opens for it', () => {
    const blocked: string[] = []
    for (const role of ALL_ROLES) {
      for (const p of pagesForModules(mods(role))) {
        const path = p.href.split('?')[0]!
        if (!open(role, path)) blocked.push(`${role} ${path}`)
      }
    }
    expect(blocked).toEqual([])
  })

  it('RV-1: /time-clock (the one punch screen, ALL_STAFF API) opens for every login, and its API answers', async () => {
    // A director (owner, 2026-10-18) opens /director and its password only.
    expect(open('director', '/time-clock')).toBe(false)
    expect((await get('director', '/time-clock/status')).statusCode).toBe(403)
    for (const p of ['/hr/me', '/team', '/ceo/approvals', '/help', '/w/operations']) expect(open('director', p), p).toBe(false)
    expect(open('director', '/director')).toBe(true)
    expect(open('director', '/account/password')).toBe(true)
    for (const role of ALL_ROLES.filter((r) => r !== 'director')) {
      expect(open(role, '/time-clock'), `${role} page`).toBe(true)
      expect((await get(role, '/time-clock/status')).statusCode, `${role} status`).toBe(200)
    }
    // The other personal / always-open pages, likewise.
    for (const role of ALL_ROLES.filter((r) => r !== 'director')) {
      for (const path of ['/hr/me', '/team', '/ceo/approvals', '/account/password', '/help', '/w/operations']) {
        expect(open(role, path), `${role} ${path}`).toBe(true)
      }
    }
  })

  it('RV-2: par-sheet holders open the prep batch logger, and its reads + POST answer them', async () => {
    const holders = ALL_ROLES.filter((r) => r === 'admin' || mods(r).includes('par_sheet'))
    expect(holders).toEqual(expect.arrayContaining(['kitchen', 'expediter', 'boh']))
    for (const role of holders) expect(open(role, '/inventory/prep'), role).toBe(true)
    const garlicA = (await prisma.inventoryItem.create({ data: { tenantId: tenantA, name: `Garlic W3 ${RUN}`, unit: 'kg', currentStock: 10 } })).id
    const garlicB = (await prisma.inventoryItem.create({ data: { tenantId: tenantB, name: `Garlic W3B ${RUN}`, unit: 'kg', currentStock: 10 } })).id
    const logBatch = (who: string, itemId: string) => app.inject({
      method: 'POST', url: '/api/v1/crosschecks/prep-batches', headers: { authorization: tokens[who]! },
      payload: { recipeId: null, itemName: `W3 sauce ${who}`, inputs: [{ inventoryItemId: itemId, qtyDrawn: 100, unit: 'g' }], actualYieldQty: 1 },
    })
    for (const role of ['kitchen', 'expediter']) {
      expect((await get(role, '/par-sheet/preps')).statusCode, `${role} preps`).toBe(200)
      expect((await get(role, '/crosschecks/prep-batches')).statusCode, `${role} batches`).toBe(200)
      const r = await logBatch(role, garlicA)
      expect(r.statusCode, `${role} log batch: ${r.body}`).toBeLessThan(300)
      // Another company's stock item cannot be drawn.
      expect((await logBatch(role, garlicB)).statusCode, `${role} foreign item`).toBe(404)
    }
    // Company separation on the batches just logged: B's kitchen sees none.
    const b = (await get('kitchenB', '/crosschecks/prep-batches')).json() as Array<{ itemName?: string }> | { data: Array<{ itemName?: string }> }
    const rows = Array.isArray(b) ? b : b.data
    expect(rows.some((x) => (x.itemName ?? '').startsWith('W3 sauce'))).toBe(false)
    // The rest of Inventory stays with its own module.
    expect(open('kitchen', '/inventory')).toBe(false)
    expect(open('kitchen', '/inventory/count')).toBe(false)
    expect(open('cashier', '/inventory/prep')).toBe(false)
  })

  it('RV-4: kds_all holders (the expediter) open the bare /kds and its station pages; others do not', async () => {
    for (const role of ALL_ROLES) {
      const m = mods(role)
      const want = role === 'admin' || m.includes('kds_dashboard') || m.includes('kds_all')
      expect(open(role, '/kds'), `${role} /kds`).toBe(want)
      expect(open(role, '/kds/grill'), `${role} /kds/grill`).toBe(want)
    }
    expect(open('expediter', '/kds')).toBe(true)
    expect(open('expediter', '/kds/config')).toBe(false) // kds_config only
    expect((await get('expediter', '/kds/my-stations')).statusCode).toBe(200)
  })
})

describe('W3E-RV-5 a saved Module Access row controls the KDS writes too', () => {
  const WRITES = ['/api/v1/expo/steps/x/bump', '/api/v1/expo/orders/x/fire', '/api/v1/expo/orders/x/handoff', '/api/v1/expo/queue']
  it('kitchen keeps bump / fire / hand-off with any one kitchen module; a row with none stops them (documented)', async () => {
    const saved = await prisma.roleModuleAccess.findUnique({ where: { role: 'kitchen' } })
    try {
      // Defaults (kds_dashboard): through.
      invalidateModuleAccessCache()
      for (const u of WRITES) await expect(enforceModuleAccess(u, { role: 'kitchen' }), u).resolves.toBeUndefined()
      // A saved row without kds_dashboard but with kds_all: still through (anyOf).
      await prisma.roleModuleAccess.upsert({
        where: { role: 'kitchen' },
        create: { role: 'kitchen', modules: ['kds_all', 'par_sheet', 'food_safety'] },
        update: { modules: ['kds_all', 'par_sheet', 'food_safety'] },
      })
      invalidateModuleAccessCache()
      for (const u of WRITES) await expect(enforceModuleAccess(u, { role: 'kitchen' }), u).resolves.toBeUndefined()
      // A saved row with NO kitchen module: the KDS stops — reads and writes
      // alike (module access is the control; the comments say so).
      await prisma.roleModuleAccess.update({ where: { role: 'kitchen' }, data: { modules: ['par_sheet', 'food_safety'] } })
      invalidateModuleAccessCache()
      for (const u of WRITES) await expect(enforceModuleAccess(u, { role: 'kitchen' }), u).rejects.toThrow(/module/)
      // The per-item bump is never module-gated.
      await expect(enforceModuleAccess('/api/v1/order-items/x/status', { role: 'kitchen' })).resolves.toBeUndefined()
    } finally {
      if (saved) await prisma.roleModuleAccess.update({ where: { role: 'kitchen' }, data: { modules: saved.modules } })
      else await prisma.roleModuleAccess.deleteMany({ where: { role: 'kitchen' } })
      invalidateModuleAccessCache()
    }
  })
})
