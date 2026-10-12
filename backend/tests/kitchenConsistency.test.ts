// Kitchen + admin consistency (post-Monday round, stream K).
//
// What this guards:
//   - Courses reload: GET /orders/:id/courses carries each line's
//     scheduledFireAt, so the admin Courses page still says "fires at HH:MM"
//     for a paced dish after a reload (it used to know only the last fire
//     response). Later courses carry none. Company B gets 404 on company A's
//     order.
//   - One managers list: GET /permissions/role-modules serves roles.managers
//     (= the auth middleware's MANAGERS), distinct from roles.overrideApprovers
//     (which omits the legacy 'manager'). The admin's static fallback
//     (frontend/admin/src/lib/roles.ts MANAGER_ROLES_FALLBACK) matches it.
//   - One order reference: the admin and tablet orderRef() use the receipts'
//     rule (last 8 characters, uppercased — pos/receipt.ts, prebills orderRefOf);
//     the tablet copy is compared as source.
//   - Tablet KDS tap (K-RV-1): only a FIRED line can be tapped done, per line.
//     A later course on a fired ticket comes back from /expo/queue as pending,
//     firedAt null, scheduledFireAt null; the tablet's isLineFired() (read from
//     its source) locks it, and the course can still be fired afterwards.
//   - Customer / rider order number (K-RV-2): PENDING — the rider job's
//     orderNumber and the customer messages still use the first 8 characters
//     (files outside stream K; see the skipped block at the end).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { UserRole } from '@prisma/client'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { MANAGERS } from '../src/modules/auth/middleware.js'
import { OVERRIDE_APPROVERS } from '../src/lib/roles.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ingestOrder } from '../src/modules/orders/service.js'
import { orderRefOf } from '../src/modules/prebills/service.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { orderCourseRoutes } from '../src/modules/orders/routes.js'
import { permissionRoutes } from '../src/modules/permissions/routes.js'
import { orderRef as adminOrderRef } from '../../frontend/admin/src/lib/orderRef.js'
import { toJob } from '../src/modules/rider/service.js'

let app: FastifyInstance
let conceptA: string
let classicId: string
let friesId: string
let cakeId: string
const tok: Record<string, string> = {}

function dto(items: Array<{ id: string; name: string; course?: number }>): OrderDTO {
  return {
    source: 'servd',
    external_id: `direct-${crypto.randomUUID()}`,
    concept_id: conceptA,
    placed_at: new Date().toISOString(),
    customer_id: null,
    customer_name: 'Guest',
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
    fulfilment_type: 'takeout',
    items: items.map((i) => ({ externalItemId: i.id, menuItemId: i.id, name: i.name, quantity: 1, unitPriceCents: 50_000, modifiers: [], course: i.course })),
    payment: { provider: null, amountCents: 50_000 * items.length, status: 'pending' },
  }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${tok[who]}` } })
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  const tenantA = (await prisma.tenant.create({ data: { name: 'Consistency K A', slug: 'consist-k-a' } })).id
  const tenantB = (await prisma.tenant.create({ data: { name: 'Consistency K B', slug: 'consist-k-b' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptA = (await prisma.concept.create({
    data: { name: 'CK Flipd', slug: 'consist-k-flipd', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  await prisma.concept.create({
    data: { name: 'CK Viva', slug: 'consist-k-viva', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })
  const cat = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  const grill = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill', displayOrder: 1 } })).id
  const fry = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry', displayOrder: 2 } })).id
  const menu = async (name: string, stationId: string, labor: number) => {
    const id = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name, priceCents: 50_000, stationId } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: id, laborMinutes: labor } })
    return id
  }
  classicId = await menu('Classic', grill, 8)
  friesId = await menu('Fries', fry, 3)
  cakeId = await menu('Cake', grill, 2)

  const mk = async (key: string, tenantId: string, role: UserRole) => {
    const u = await prisma.user.create({
      data: { name: key, email: `consist-k-${key}@test.local`, password: 'x', role, isActive: true, accountStatus: 'active', tenantId },
    })
    tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  }
  await mk('expoA', tenantA, 'expediter')
  await mk('cookA', tenantA, 'kitchen')
  await mk('expoB', tenantB, 'expediter')
  await mk('mgrB', tenantB, 'boh_management')

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderCourseRoutes, { prefix: '/orders' })
  await app.register(permissionRoutes, { prefix: '/permissions' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

type CourseItem = { id: string; name: string; status: string; firedAt: string | null; scheduledFireAt?: string | null }
type CourseGroup = { course: number; fired: boolean; complete: boolean; items: CourseItem[] }

describe('Courses reload — GET /orders/:id/courses carries scheduledFireAt', () => {
  it('a paced line keeps its fire time after a reload; a later course has none; company B gets 404', async () => {
    const { order } = await ingestOrder(dto([
      { id: classicId, name: 'Classic', course: 1 },
      { id: friesId, name: 'Fries', course: 1 },
      { id: cakeId, name: 'Cake', course: 2 },
    ]))
    await settle()
    const t0 = Date.now()
    const fire = await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})
    expect(fire.statusCode).toBe(200)
    const paced = (fire.json() as { paced: Array<{ id: string; scheduledFireAt: string }> }).paced
    expect(paced).toHaveLength(1)

    // "Reload": a fresh read of the summary, with no fire response in hand.
    const res = await call('cookA', 'GET', `/orders/${order.id}/courses`)
    expect(res.statusCode).toBe(200)
    const groups = res.json() as CourseGroup[]
    const c1 = groups.find((g) => g.course === 1)!
    const c2 = groups.find((g) => g.course === 2)!
    expect(c1.fired).toBe(true)

    const fries = c1.items.find((i) => i.name === 'Fries')!
    expect(fries.status).toBe('pending')
    expect(fries.firedAt).toBeNull()
    expect(fries.scheduledFireAt).toBeTruthy()
    // The time the fire response reported (expo re-anchors and stores it in
    // a separate step, so allow a few ms), ~5 min (8 − 3) after the fire.
    const at = new Date(fries.scheduledFireAt!).getTime()
    expect(Math.abs(at - new Date(paced[0]!.scheduledFireAt).getTime())).toBeLessThan(1_000)
    expect(at - t0).toBeGreaterThan(4.5 * 60_000)
    expect(at - t0).toBeLessThan(5.5 * 60_000)

    const classic = c1.items.find((i) => i.name === 'Classic')!
    expect(classic.firedAt).not.toBeNull()
    // The field is always present (null when not paced), never left out.
    expect(Object.prototype.hasOwnProperty.call(classic, 'scheduledFireAt')).toBe(true)

    // A later course is never paced — "Fire course" fires it.
    const cake = c2.items.find((i) => i.name === 'Cake')!
    expect(cake.scheduledFireAt).toBeNull()
    expect(c2.fired).toBe(false)

    // Company separation: another company's staff cannot read the courses.
    expect((await call('expoB', 'GET', `/orders/${order.id}/courses`)).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/orders/${order.id}/courses`)).statusCode).toBe(404)
  })
})

describe('One managers list — GET /permissions/role-modules → roles.managers', () => {
  it('serves the auth middleware MANAGERS, distinct from the override approvers', async () => {
    const res = await call('cookA', 'GET', '/permissions/role-modules')
    expect(res.statusCode).toBe(200)
    const roles = (res.json() as { roles: { managers: string[]; overrideApprovers: string[] } }).roles
    expect(roles.managers).toEqual([...MANAGERS])
    expect(roles.managers).toContain('manager')               // legacy tier still passes MANAGERS gates
    expect(roles.overrideApprovers).toEqual([...OVERRIDE_APPROVERS])
    expect(roles.overrideApprovers).not.toContain('manager')  // … but never approves overrides
    // The same answer for every company's staff.
    const resB = await call('expoB', 'GET', '/permissions/role-modules')
    expect((resB.json() as { roles: { managers: string[] } }).roles.managers).toEqual([...MANAGERS])
  })

  it("the admin's static fallback matches the server list", () => {
    const src = readFileSync(fileURLToPath(new URL('../../frontend/admin/src/lib/roles.ts', import.meta.url)), 'utf8')
    const m = /MANAGER_ROLES_FALLBACK: readonly string\[\] = \[([^\]]*)\]/.exec(src)
    expect(m).not.toBeNull()
    const fallback = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    expect(fallback).toEqual([...MANAGERS])
  })
})

describe('One order reference — the receipts rule everywhere', () => {
  it('admin and tablet orderRef = last 8 characters uppercased, same as receipts / pre-bills', () => {
    const id = '3f2b9c1e-7a4d-4e8b-9c2f-1a2b4f3a9c1b'
    expect(adminOrderRef(id)).toBe('4F3A9C1B')
    expect(adminOrderRef(id)).toBe(orderRefOf(id))
    expect(adminOrderRef(id)).toBe(id.slice(-8).toUpperCase())   // pos/receipt.ts orderRef
    expect(adminOrderRef(null)).toBe('')
  })

  it('the tablet copy has the same implementation as the admin one', () => {
    // The tablet's tsconfig extends expo's (not installed with the backend),
    // so the copy is compared as source rather than imported.
    const body = (rel: string) => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      const m = /export function orderRef\(([^)]*)\): string \{([\s\S]*?)\n\}/.exec(src)
      expect(m).not.toBeNull()
      return `${m![1]}|${m![2]!.trim()}`
    }
    const admin = body('../../frontend/admin/src/lib/orderRef.ts')
    expect(admin).toContain('id.slice(-8).toUpperCase()')
    expect(body('../../tablet/src/lib/orderRef.ts')).toBe(admin)
  })
})

type QueueItem = { id: string; name: string; status: string; firedAt: string | null; scheduledFireAt: string | null }
type QueueOrder = { id: string; items: QueueItem[] }
type Queue = { awaitingFire: QueueOrder[]; inProgress: QueueOrder[]; ready: QueueOrder[] }

/**
 * The tablet KDS's own isLineFired (tablet/app/(staff)/kds/index.tsx), read
 * from source: the tablet's tsconfig extends expo's, and a route file cannot
 * be imported here.
 */
function tabletIsLineFired(): (it: { status: string; firedAt: string | null }) => boolean {
  const src = readFileSync(fileURLToPath(new URL('../../tablet/app/(staff)/kds/index.tsx', import.meta.url)), 'utf8')
  const m = /function isLineFired\(it: [^)]*\): boolean \{\s*return ([^\n]+)\n\}/.exec(src)
  expect(m).not.toBeNull()
  return new Function('it', `return ${m![1]}`) as (it: { status: string; firedAt: string | null }) => boolean
}

describe('Tablet KDS — an unfired later course on a FIRED ticket is not tappable (K-RV-1)', () => {
  it('course 2 is pending / firedAt null / scheduledFireAt null in /expo/queue; the tablet locks it; it can still be fired', async () => {
    const { order } = await ingestOrder(dto([
      { id: classicId, name: 'Classic', course: 1 },
      { id: friesId, name: 'Fries', course: 1 },
      { id: cakeId, name: 'Cake', course: 2 },
    ]))
    await settle()
    expect((await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).statusCode).toBe(200)

    const res = await call('expoA', 'GET', '/expo/queue')
    expect(res.statusCode).toBe(200)
    const queue = res.json() as Queue
    // A fired order sits in the FIRED lane (inProgress), not NEW.
    expect(queue.awaitingFire.some((o) => o.id === order.id)).toBe(false)
    const onPass = queue.inProgress.find((o) => o.id === order.id)!
    expect(onPass).toBeDefined()
    const line = (name: string) => onPass.items.find((i) => i.name === name)!

    // The data shape the tablet relies on.
    const cake = line('Cake')
    expect(cake.status).toBe('pending')
    expect(cake.firedAt).toBeNull()
    expect(cake.scheduledFireAt).toBeNull()        // not paced — the old pacedById guard missed it
    const fries = line('Fries')                       // paced: also pending, never fired
    expect(fries.status).toBe('pending')
    expect(fries.firedAt).toBeNull()
    expect(fries.scheduledFireAt).toBeTruthy()
    const classic = line('Classic')
    expect(classic.firedAt).not.toBeNull()

    // The tablet's per-line rule: only the fired line can be tapped done.
    const isLineFired = tabletIsLineFired()
    expect(isLineFired(classic)).toBe(true)
    expect(isLineFired(fries)).toBe(false)
    expect(isLineFired(cake)).toBe(false)
    // Any line past pending is fired (held / recalled / ready / bumped).
    for (const status of ['preparing', 'held', 'recalled', 'ready', 'bumped']) {
      expect(isLineFired({ status, firedAt: null })).toBe(true)
    }

    // The tablet wires the rule per line and has no per-ticket switch left.
    const kds = readFileSync(fileURLToPath(new URL('../../tablet/app/(staff)/kds/index.tsx', import.meta.url)), 'utf8')
    expect(kds).toContain("tappable: status !== 'new' && isLineFired(it)")
    const ticket = readFileSync(fileURLToPath(new URL('../../tablet/src/components/OrderTicket.tsx', import.meta.url)), 'utf8')
    expect(ticket).not.toContain('itemsTappable')
    expect(ticket).toContain('it.tappable === false')

    // Nothing bumped the dessert, so its course still fires.
    const fired = await call('expoA', 'POST', `/orders/${order.id}/fire-course`, { course: 2 })
    expect(fired.statusCode).toBe(200)
    const after = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id, name: 'Cake' }, select: { status: true, firedAt: true } })
    expect(after.status).toBe('preparing')
    expect(after.firedAt).not.toBeNull()

    // Company B's pass never sees company A's order.
    const qB = (await call('expoB', 'GET', '/expo/queue')).json() as Queue
    expect([...qB.awaitingFire, ...qB.inProgress, ...qB.ready].some((o) => o.id === order.id)).toBe(false)
  })
})

// K-RV-2 — landed: lib/orderRef.ts is the one rule (last 8, uppercase).
// (lib/notify.ts:172 and rider/service.ts:99/:383 → orderRefOf). Until then
// the rider job card and the customer's messages show the FIRST 8 characters,
// while receipts, pre-bills, the storefront order page and every staff screen
// show the LAST 8.
describe('Customer and rider order number = the receipts rule (K-RV-2)', () => {
  it("the rider job's orderNumber equals orderRefOf(id)", () => {
    const id = '3f2b9c1e-7a4d-4e8b-9c2f-1a2b4f3a9c1b'
    const row = {
      id, conceptId: 'c', status: 'ready', placedAt: new Date(), customerName: 'Guest', deliveryNotes: null, rawPayload: {},
      riderAssignedAt: null, riderAcceptedAt: null, pickedUpAt: null, arrivedAt: null, deliveryOtp: null, deliveryOtpAttempts: 0,
      concept: { name: 'Flipd', slug: 'flipd', phone: null, address: null, addressLocality: null, latitude: null, longitude: null, tenantId: 't', tenant: { id: 't', name: 'T' } },
      location: null, customer: null, items: [], payments: [],
    } as Parameters<typeof toJob>[0]
    expect(toJob(row).orderNumber).toBe(orderRefOf(id))
  })

  it('no customer- or rider-facing message cuts the order id to its first 8 characters', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    expect(read('../src/lib/notify.ts')).not.toMatch(/orderId\.slice\(0, 8\)/)
    expect(read('../src/modules/rider/service.ts')).not.toMatch(/\bo\.id\.slice\(0, 8\)/)
  })
})
