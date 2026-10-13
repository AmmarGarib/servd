// Small duplicate surfaces and dead paths (reconcile batch "dups2").
//
//   Pure:     the one haversine (lib/geo), the one backend PKR formatter and
//             CSV writer (accounting/csv), the one active-company helper
//             (lib/tenantScope), normalisePhone as the one phone key.
//   Routes:   the retired writers are really gone (/reservations/service-hours,
//             /setup/holidays, /kds/items|queue|metrics, the deposit-capture
//             route, /auth/clock-logs); /setup/hours keeps split windows; the
//             recipe builder's component picker is company-scoped.
//   Real DB:  one no-show path — the manual route and the auto sweep both go
//             through markNoShow: deposit captured to the ledger, strike,
//             waitlist promotion, idempotent, never from seated.
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
const { haversineKm, haversineMeters } = await import('../src/lib/geo.js')
const setupConfig = await import('../src/lib/setup-config.js')
const { fmtPkr, csv, toCsv, csvCell } = await import('../src/modules/accounting/csv.js')
const hrRoutesModule = await import('../src/modules/hr/routes.js')
const { requireTenantId, activeTenantId } = await import('../src/lib/tenantScope.js')
const { normalisePhone } = await import('../src/modules/auth/otp.js')
const { markNoShow } = await import('../src/modules/reservations/noShow.js')
const { reservationRoutes } = await import('../src/modules/reservations/routes.js')
const { setupRoutes } = await import('../src/modules/setup/routes.js')
const { kdsRoutes } = await import('../src/modules/kds/routes.js')
const { parSheetRoutes } = await import('../src/modules/par-sheet/routes.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')

// ─── pure ───────────────────────────────────────────────────────────────────

describe('one haversine (lib/geo)', () => {
  it('measures Karachi → Lahore at about 1,030 km, in km and metres', () => {
    const km = haversineKm(24.8607, 67.0011, 31.5204, 74.3587)
    expect(km).toBeGreaterThan(1000)
    expect(km).toBeLessThan(1060)
    expect(haversineMeters(24.8607, 67.0011, 31.5204, 74.3587)).toBeCloseTo(km * 1000, 3)
    expect(haversineMeters(24.86, 67.0, 24.86, 67.0)).toBe(0)
  })
  it('is what delivery-zone matching re-exports', () => {
    expect(setupConfig.haversineKm).toBe(haversineKm)
  })
})

describe('one backend PKR formatter and CSV writer (accounting/csv)', () => {
  it('formats for accountants, receipts and the WhatsApp bot from one function', () => {
    expect(fmtPkr(123456)).toBe('1,234.56')
    expect(fmtPkr(-5)).toBe('-0.05')
    expect(fmtPkr(151000, { symbol: true, group: false })).toBe('PKR 1510.00')      // receipt
    expect(fmtPkr(123450, { symbol: true, decimals: 0, group: false })).toBe('PKR 1235') // WhatsApp
    expect(fmtPkr(-1250, { symbol: true, group: false })).toBe('PKR -12.50')
  })
  it('guards formulas in every export while leaving amounts as numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('-1,234.56')).toBe('"-1,234.56"')          // grouped negative stays a number (quoted for the comma)
    expect(csvCell(-1500)).toBe('-1500')
    expect(toCsv([{ name: '@evil', amount: '-12.00' }])).toBe("﻿name,amount\r\n'@evil,-12.00\r\n")
    expect(csv([[-1500, '-1500.00', '-x']])).toBe("-1500,-1500.00,'-x")
    // HR keeps importing csv from its routes module — it is the same function.
    expect(hrRoutesModule.csv).toBe(csv)
  })
})

describe('one active-company helper and one phone key', () => {
  it('422s with NO_ACTIVE_COMPANY when there is no active company', () => {
    expect(requireTenantId('t1')).toBe('t1')
    expect(activeTenantId({ staffUser: { tenantId: 't2' } })).toBe('t2')
    try {
      activeTenantId({ staffUser: { tenantId: null } }, 'the ledger is per company')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as InstanceType<typeof AppError>).statusCode).toBe(422)
      expect((e as InstanceType<typeof AppError>).code).toBe('NO_ACTIVE_COMPANY')
      expect((e as Error).message).toBe('Pick a company first — the ledger is per company')
    }
  })
  it('treats 0300…, +92 300… and 92300… as one number', () => {
    const k = normalisePhone('0300-1234567')
    expect(k).toBe('923001234567')
    expect(normalisePhone('+92 300 1234567')).toBe(k)
    expect(normalisePhone('923001234567')).toBe(k)
    expect(normalisePhone('3001234567')).toBe(k)
  })
})

// ─── through the API ────────────────────────────────────────────────────────

let app: FastifyInstance
let tenantId: string
let otherTenantId: string
let conceptId: string
let otherConceptId: string
const tokens: Record<string, string> = {}
const PREFIX = 'dedupe-small'

async function mkUser(key: string, role: string, tenant: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${PREFIX}.${key}.${Date.now()}@gsfoods.pk`,
      password: await bcrypt.hash('x-Password-1', 4), role: role as never,
      isActive: true, accountStatus: 'active', tenantId: tenant,
      tenantMemberships: { create: [{ tenant: { connect: { id: tenant } }, role: 'member' }] },
    },
  })
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  return u.id
}

const call = (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${tokens[who]!}` } })

async function mkReservation(data: Record<string, unknown>) {
  const start = (data['startTime'] as Date | undefined) ?? new Date(Date.now() - 3 * 3_600_000)
  return prisma.reservation.create({
    data: {
      conceptId, partySize: 4, guestName: 'Guest', source: 'staff',
      startTime: start, endTime: new Date(start.getTime() + 90 * 60_000),
      status: 'confirmed',
      ...data,
    } as never,
  })
}

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Dedupe Co', slug: `${PREFIX}-a-${Date.now()}` } })).id
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Dedupe Other', slug: `${PREFIX}-b-${Date.now()}` } })).id
  conceptId = (await prisma.concept.create({ data: { name: 'dedupe brand', slug: `${PREFIX}-brand-${Date.now()}`, type: 'restaurant', tenantId } as never })).id
  otherConceptId = (await prisma.concept.create({ data: { name: 'other brand', slug: `${PREFIX}-other-${Date.now()}`, type: 'restaurant', tenantId: otherTenantId } as never })).id
  await ensureChartOfAccounts(tenantId)

  await mkUser('mgr', 'management', tenantId)
  await mkUser('cook', 'kitchen', tenantId)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.register(kdsRoutes, { prefix: '/kds' })
  await app.register(parSheetRoutes, { prefix: '/par-sheet' })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('retired duplicate writers are gone', () => {
  it('no second hours / closures writer, no raw KDS item movers, no deposit-capture side door, no old punch report', () => {
    const gone: Array<[string, string]> = [
      ['GET', '/reservations/service-hours'], ['PUT', '/reservations/service-hours'],
      ['GET', '/setup/holidays'], ['POST', '/setup/holidays'], ['DELETE', '/setup/holidays/:id'],
      ['POST', '/kds/items/:itemId/fire'], ['POST', '/kds/items/:itemId/bump'], ['POST', '/kds/items/:itemId/recall'],
      ['GET', '/kds/queue/:stationId'], ['GET', '/kds/metrics/:stationId'],
      ['POST', '/reservations/:id/deposit-capture'],
      ['GET', '/auth/clock-logs'],
    ]
    for (const [method, url] of gone) expect(app.hasRoute({ method: method as never, url }), `${method} ${url}`).toBe(false)

    const kept: Array<[string, string]> = [
      ['GET', '/setup/hours/:conceptId'], ['PUT', '/setup/hours/:conceptId'],
      ['GET', '/reservations/blockouts'], ['POST', '/reservations/blockouts'],
      ['GET', '/kds/stations'], ['GET', '/kds/my-stations'],
      ['POST', '/reservations/:id/no-show'],
      ['GET', '/par-sheet/preps'],
    ]
    for (const [method, url] of kept) expect(app.hasRoute({ method: method as never, url }), `${method} ${url}`).toBe(true)
  })

  it('closures take only BlockoutKind values (the old writer\'s special_hours is refused)', async () => {
    const start = new Date(Date.now() + 86_400_000).toISOString()
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const bad = await call('mgr', 'POST', '/reservations/blockouts', { conceptId, kind: 'special_hours', startTime: start, endTime: end })
    expect(bad.statusCode).toBe(400)
    const ok = await call('mgr', 'POST', '/reservations/blockouts', { conceptId, kind: 'custom', startTime: start, endTime: end, reason: 'Eid hours' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().kind).toBe('custom')
  })
})

describe('service hours — the one writer keeps split windows', () => {
  it('saves lunch and dinner on the same day and reads them back in order', async () => {
    const put = await call('mgr', 'PUT', `/setup/hours/${conceptId}`, {
      hours: [
        { dayOfWeek: 5, openMin: 18 * 60, closeMin: 23 * 60, isReservable: true },
        { dayOfWeek: 5, openMin: 12 * 60, closeMin: 15 * 60, isReservable: false },
        { dayOfWeek: 6, openMin: 12 * 60, closeMin: 23 * 60 },
      ],
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ saved: 3 })
    const got = (await call('mgr', 'GET', `/setup/hours/${conceptId}`)).json() as Array<{ dayOfWeek: number; openMin: number; isReservable: boolean }>
    expect(got.filter((h) => h.dayOfWeek === 5).map((h) => [h.openMin, h.isReservable])).toEqual([[720, false], [1080, true]])
    expect(got.find((h) => h.dayOfWeek === 6)!.isReservable).toBe(true)
  })
  it('refuses another company\'s brand', async () => {
    const res = await call('mgr', 'PUT', `/setup/hours/${otherConceptId}`, { hours: [] })
    expect(res.statusCode).toBe(404)
  })
})

describe('one no-show path (markNoShow)', () => {
  it('a host\'s no-show captures the deposit to the ledger, strikes, and offers the slot to the waitlist', async () => {
    const customer = await prisma.customer.create({ data: { name: 'No Show Nadia', phone: `92300${Date.now() % 10_000_000}` } })
    const r = await mkReservation({ customerId: customer.id, depositCents: 250_000, depositRef: 'KEENU-1' })
    const waiting = await mkReservation({ status: 'booked', waitlist: true, partySize: 2, guestName: 'Waiting Wasim', guestPhone: '03001112222', startTime: new Date(r.startTime.getTime() + 30 * 60_000) })

    const res = await call('mgr', 'POST', `/reservations/${r.id}/no-show`)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('no_show')

    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { reference: `reservation.deposit_capture:${r.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(je.tenantId).toBe(tenantId)
    const byCode = Object.fromEntries(je.lines.map((l) => [`${l.account.code}:${l.type}`, l.amountCents]))
    // The hold is gateway money (1030), not money already in the bank; the
    // credit stays 4100 until the tax treatment is decided (G9).
    expect(byCode).toEqual({ '1030:debit': 250_000, '4100:credit': 250_000 })
    expect(je.lines.every((l) => l.conceptId === r.conceptId)).toBe(true)
    // Captured money is no longer "held": a release cannot release it.
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).depositCents).toBe(0)
    const release = await call('mgr', 'POST', `/reservations/${r.id}/deposit-release`)
    expect(release.statusCode).toBe(409)
    expect(release.json().error.code).toBe('NO_DEPOSIT_HELD')

    const strikes = await prisma.customerStrike.findMany({ where: { customerId: customer.id, sourceId: r.id } })
    expect(strikes).toHaveLength(1)
    expect(strikes[0]!.reason).toBe('Staff marked as no-show.')

    // Waitlist promotion is fire-and-forget; give it a moment.
    await new Promise((ok) => setTimeout(ok, 300))
    const promoted = await prisma.reservation.findUniqueOrThrow({ where: { id: waiting.id } })
    expect(promoted.promotionToken).not.toBeNull()

    // Idempotent: a second tap does nothing more.
    const again = await call('mgr', 'POST', `/reservations/${r.id}/no-show`)
    expect(again.statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { reference: `reservation.deposit_capture:${r.id}` } })).toBe(1)
    expect(await prisma.customerStrike.count({ where: { sourceId: r.id } })).toBe(1)
  })

  it('the auto sweep takes the same path', async () => {
    const customer = await prisma.customer.create({ data: { name: 'Auto Ahmed', phone: `92301${Date.now() % 10_000_000}` } })
    const r = await mkReservation({ customerId: customer.id, depositCents: 100_000 })
    const out = await markNoShow(r.id, { reason: 'Auto: no-show after window', actorId: null, auto: true })
    expect(out.marked).toBe(true)
    if (out.marked) expect(out.depositCapturedCents).toBe(100_000)
    expect(await prisma.journalEntry.count({ where: { reference: `reservation.deposit_capture:${r.id}` } })).toBe(1)
    const strike = await prisma.customerStrike.findFirstOrThrow({ where: { sourceId: r.id } })
    expect(strike.reason).toMatch(/Auto-detected/)
    // A second sweep of the same row is a no-op.
    expect((await markNoShow(r.id, { reason: 'Auto again', actorId: null, auto: true })).marked).toBe(false)
  })

  it('never marks a seated or completed booking a no-show', async () => {
    const seated = await mkReservation({ status: 'seated', seatedAt: new Date() })
    const res = await call('mgr', 'POST', `/reservations/${seated.id}/no-show`)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('RESERVATION_CLOSED')
    expect((await markNoShow(seated.id, { reason: 'x', actorId: null, auto: true })).marked).toBe(false)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: seated.id } })).status).toBe('seated')
  })

  it('does not reach another company\'s booking', async () => {
    const foreign = await prisma.reservation.create({
      data: { conceptId: otherConceptId, partySize: 2, guestName: 'Foreign', source: 'staff', status: 'confirmed',
        startTime: new Date(Date.now() - 3 * 3_600_000), endTime: new Date(Date.now() - 90 * 60_000) },
    })
    const res = await call('mgr', 'POST', `/reservations/${foreign.id}/no-show`)
    expect(res.statusCode).toBe(404)
  })
})

describe('the recipe builder\'s component picker is the par sheet\'s, company-scoped', () => {
  it('lists this company\'s sub-recipes and unused ones with cost per gram, never another company\'s', async () => {
    const cat = await prisma.category.create({ data: { conceptId, name: 'Mains' } })
    const otherCat = await prisma.category.create({ data: { conceptId: otherConceptId, name: 'Mains' } })
    const mine = await prisma.recipe.create({ data: { kind: 'component', name: `${PREFIX} caramel`, yieldGrams: 1000 } })
    const unused = await prisma.recipe.create({ data: { kind: 'component', name: `${PREFIX} new glaze`, yieldGrams: 500 } })
    const theirs = await prisma.recipe.create({ data: { kind: 'component', name: `${PREFIX} their sauce`, yieldGrams: 800 } })
    const theirStock = await prisma.inventoryItem.create({ data: { tenantId: otherTenantId, name: `${PREFIX} their flour`, unit: 'kg', unitCostCents: 20_000 } as never })
    const theirUnused = await prisma.recipe.create({ data: { kind: 'component', name: `${PREFIX} their dough`, yieldGrams: 900,
      ingredients: { create: [{ inventoryItemId: theirStock.id, quantity: 500, unit: 'g' }] } } })
    const myItem = await prisma.menuItem.create({ data: { conceptId, categoryId: cat.id, name: 'Shortbread', priceCents: 50_000 } as never })
    const theirItem = await prisma.menuItem.create({ data: { conceptId: otherConceptId, categoryId: otherCat.id, name: 'Wings', priceCents: 90_000 } as never })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: myItem.id, ingredients: { create: [{ prepRecipeId: mine.id, quantity: 40, unit: 'g' }] } } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: theirItem.id, ingredients: { create: [{ prepRecipeId: theirs.id, quantity: 60, unit: 'g' }] } } })

    const res = await call('mgr', 'GET', '/par-sheet/preps?for=recipe')
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; costPerGramCents: number; batchCostCents: number }>
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(mine.id)
    expect(ids).toContain(unused.id)
    expect(ids).not.toContain(theirs.id)
    expect(ids).not.toContain(theirUnused.id)   // unused, but made from the other company's stock
    const row = rows.find((r) => r.id === mine.id)!
    expect(typeof row.costPerGramCents).toBe('number')
    expect(typeof row.batchCostCents).toBe('number')

    // Costs are manager data; a cook gets the par sheet but not the priced picker.
    expect((await call('cook', 'GET', '/par-sheet/preps?for=recipe')).statusCode).toBe(403)
    const sheet = await call('cook', 'GET', '/par-sheet/preps')
    expect(sheet.statusCode).toBe(200)
    expect((sheet.json() as Array<{ id: string }>).map((r) => r.id)).toContain(mine.id)
  })
})
