// Station board, Start, cook timers, expo backlog + 60-second alert, bag
// stickers (owner B12, 2026-10-26) — modules/expo/kitchenBoard.ts.
//
// What this guards:
//   • A station shows at most visibleCards (fixed at 4, owner 2026-10-30) ORDER cards,
//     oldest first; the rest queue. kdsShownAt is stamped on first show.
//   • A visible card not started for 60 s is on the expo's alert list; Start
//     (or a timer) takes it off. A held card is never alerted.
//   • Expo backlog = orders queued somewhere and visible nowhere.
//   • Timers persist (started at + duration), +/− and stop; company-scoped.
//   • The tick at station 1 fires the next station's step (the cascade);
//     the tick at the last station bumps the dish and the order goes ready.
//   • Display setting, sticker size and print are company-scoped (404).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { backlogOf, groupCards, splitWindow, unstartedCards, renderPrint, type BoardEntry, type BoardOrder } from '../src/modules/expo/kitchenBoard.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let categoryA: string
let grillA: string
let fryA: string
let passA: string
let grillB: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.kdsboard@test.local`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

let n = 0
/** A fired legacy line (no recipe steps) on a station. */
async function lineOrder(stationId: string, minutesAgo: number, conceptId = conceptA, extra: { status?: 'preparing' | 'held' } = {}) {
  n += 1
  const at = new Date(Date.now() - minutesAgo * 60_000)
  return prisma.order.create({
    data: {
      conceptId, source: 'pos', status: 'preparing', fulfilmentType: 'takeout', totalCents: 50_000, placedAt: at,
      externalId: `kds-board-${n}-${Date.now()}`, customerName: `Guest ${n}`,
      items: { create: [{ name: `Wrap ${n}`, quantity: 1, unitPriceCents: 50_000, stationId, status: extra.status ?? 'preparing', firedAt: at, notes: 'no onion',
        modifiers: { create: [{ name: 'Extra cheese' }] } }] },
    },
    include: { items: true },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Board A', slug: 'kds-board-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Board B', slug: 'kds-board-b' } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Board Diner', slug: 'kds-board-diner', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Board Other', slug: 'kds-board-other', type: 'restaurant', tenantId: tenantB } })).id
  categoryA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  grillA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill', displayOrder: 1 } })).id
  fryA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry', displayOrder: 2 } })).id
  passA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Pass', displayOrder: 3 } })).id
  grillB = (await prisma.station.create({ data: { conceptId: conceptB, name: 'Grill B' } })).id

  await mkUser('cookA', 'kitchen', tenantA)
  await mkUser('cookB', 'kitchen', tenantB)
  await mkUser('expoA', 'expediter', tenantA)
  await mkUser('chefA', 'boh_management', tenantA)
  await mkUser('mgrB', 'manager', tenantB)
  await mkUser('ceoA', 'admin', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.ready()
})

afterAll(async () => { await app.close() })

// ─── Pure rules ──────────────────────────────────────────────────────────────

const o = (id: string, placedMin: number): BoardOrder => ({ id, ref: id.slice(-8).toUpperCase(), brand: 'B', channel: 'pos', fulfilmentType: 'takeout', tableLabel: null, customerName: null, placedAt: new Date(Date.now() - placedMin * 60_000) })
const e = (id: string, firedMin: number, extra: Partial<BoardEntry> = {}): BoardEntry => ({
  kind: 'line', id, itemId: id, menuItemId: null, itemName: id, qty: 1, notes: null, modifiers: [], status: 'preparing',
  firedAt: new Date(Date.now() - firedMin * 60_000), startedAt: null, shownAt: null, instruction: null, instructionUrdu: null, estimatedSeconds: null, phase: null, ...extra,
})

describe('cards, window, alert, backlog (pure)', () => {
  it('groups rows per order, oldest fire first, and splits at the window (fixed at 4)', () => {
    const cards = groupCards([
      { order: o('order-new', 1), entry: e('a', 1) },
      { order: o('order-old', 9), entry: e('b', 9) },
      { order: o('order-new', 1), entry: e('c', 2) },
    ])
    expect(cards.map((c) => c.order.id)).toEqual(['order-old', 'order-new'])
    expect(cards[1]!.entries).toHaveLength(2)
    const many = Array.from({ length: 9 }, (_, i) => i)
    expect(splitWindow(many, 5).visible).toHaveLength(4)
    expect(splitWindow(many, 2).visible).toHaveLength(4)
    expect(splitWindow(many, 9).visible).toHaveLength(4)
    expect(splitWindow(many, 4).queued).toEqual([4, 5, 6, 7, 8])
  })

  it('alerts on a visible card shown 60 s+ ago and not started; never a started or held one', () => {
    const shown = new Date(Date.now() - 61_000)
    const cards = groupCards([
      { order: o('o1', 3), entry: e('x1', 3, { shownAt: shown }) },
      { order: o('o2', 3), entry: e('x2', 3, { shownAt: shown, startedAt: new Date() }) },
      { order: o('o3', 3), entry: e('x3', 3, { shownAt: shown, status: 'held' }) },
      { order: o('o4', 3), entry: e('x4', 3, { shownAt: new Date(Date.now() - 30_000) }) },
    ])
    expect(unstartedCards(cards).map((c) => c.order.id)).toEqual(['o1'])
  })

  it('backlog counts orders queued somewhere and visible nowhere', () => {
    const c = (id: string) => ({ order: { id } })
    expect(backlogOf([
      { visible: [c('a'), c('b')], queued: [c('c'), c('d')] },
      { visible: [c('c')], queued: [c('e')] },
    ])).toMatchObject({ tickets: 2, queuedCards: 3 })
  })

  it('stickers: one label per bag at the label size, with ref, brand, items; the ticket has no money', () => {
    const html = renderPrint({ id: '00000000-0000-0000-0000-00000000abcd', brand: 'Flipd', channel: 'whatsapp', fulfilmentType: 'delivery', customerName: 'Ali <b>', tableLabel: null, placedAt: new Date(), items: [{ name: 'Burger', quantity: 2, notes: null, modifiers: ['No pickle'] }] }, 'sticker', 3, { widthMm: 58, heightMm: 40 })
    expect(html).toContain('size:58mm 40mm')
    expect(html).toContain('Bag 3 of 3')
    expect(html).toContain('#0000ABCD')
    expect(html).toContain('WhatsApp · Delivery')
    expect(html).toContain('Ali &lt;b&gt;')
    expect(html.match(/class="l"/g)).toHaveLength(3)
    const ticket = renderPrint({ id: 'x0000000-0000-0000-0000-00000000abcd', brand: 'Flipd', channel: 'pos', fulfilmentType: 'dine_in', customerName: null, tableLabel: 'T4', placedAt: new Date(), items: [] }, 'ticket', 1, { widthMm: 58, heightMm: 40 })
    expect(ticket).toContain('not a bill')
    expect(ticket).toContain('Table T4')
  })
})

// ─── Board, Start, alert ─────────────────────────────────────────────────────

describe('station board', () => {
  it('shows the 4 oldest order cards, queues the rest, stamps kdsShownAt; company B gets 404', async () => {
    const orders = []
    for (let i = 7; i >= 1; i -= 1) orders.push(await lineOrder(passA, i))
    const res = await call('cookA', 'GET', `/expo/station/${passA}/board`)
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.station.visibleCards).toBe(4)
    expect(b.visible).toHaveLength(4)
    expect(b.queuedCount).toBe(3)
    expect(b.visible[0].order.id).toBe(orders[0]!.id)
    expect(b.visible[0].entries[0]).toMatchObject({ itemName: expect.stringContaining('Wrap'), notes: 'no onion', modifiers: ['Extra cheese'] })
    expect(b.visible[0].order.ref).toBe(orders[0]!.id.slice(-8).toUpperCase())
    const shown = await prisma.orderItem.findMany({ where: { orderId: { in: orders.map((x) => x.id) } }, select: { orderId: true, kdsShownAt: true } })
    expect(shown.filter((s) => s.kdsShownAt).length).toBe(4)
    expect((await call('cookB', 'GET', `/expo/station/${passA}/board`)).statusCode).toBe(404)

    // The station display is fixed at 4 cards (owner, 2026-10-30): any other count is refused.
    expect((await call('chefA', 'PUT', `/expo/stations/${passA}/display`, { visibleCards: 6 })).statusCode).toBe(400)
    expect((await call('mgrB', 'PUT', `/expo/stations/${passA}/display`, { visibleCards: 4 })).statusCode).toBe(404)
    expect((await call('cookA', 'PUT', `/expo/stations/${passA}/display`, { visibleCards: 4 })).statusCode).toBe(403)
    expect((await call('chefA', 'PUT', `/expo/stations/${passA}/display`, { visibleCards: 4 })).statusCode).toBe(200)

    // Clean the pass for the next tests.
    for (const x of orders) {
      const r = await call('cookA', 'POST', `/expo/station/${passA}/cards/${x.id}/done`)
      expect(r.statusCode).toBe(200)
    }
    expect((await call('cookA', 'GET', `/expo/station/${passA}/board`)).json().visible).toHaveLength(0)
  })

  it('a visible card 60 s+ unstarted is on the expo alert; Start clears it; backlog counts queued tickets', async () => {
    const first = await lineOrder(grillA, 10)
    const others = []
    for (let i = 9; i >= 6; i -= 1) others.push(await lineOrder(grillA, i))
    await call('cookA', 'GET', `/expo/station/${grillA}/board`) // first show
    await prisma.orderItem.updateMany({ where: { orderId: first.id }, data: { kdsShownAt: new Date(Date.now() - 90_000) } })

    const s1 = (await call('expoA', 'GET', '/expo/kitchen-status')).json()
    expect(s1.unstarted.map((u: { orderId: string }) => u.orderId)).toEqual([first.id])
    expect(s1.unstarted[0]).toMatchObject({ stationName: 'Grill', ref: first.id.slice(-8).toUpperCase() })
    expect(s1.backlog).toMatchObject({ tickets: 1, queuedCards: 1 })
    const grill = s1.stations.find((s: { id: string }) => s.id === grillA)
    expect(grill).toMatchObject({ visible: 4, queued: 1 })
    // Company B sees nothing of A.
    const sB = (await call('cookB', 'GET', '/expo/kitchen-status')).json()
    expect(sB.unstarted).toHaveLength(0)
    expect(sB.backlog.tickets).toBe(0)
    expect((await call('cookB', 'POST', `/expo/station/${grillA}/cards/${first.id}/start`)).statusCode).toBe(404)

    expect((await call('cookA', 'POST', `/expo/station/${grillA}/cards/${first.id}/start`)).statusCode).toBe(200)
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: first.id } })).startedAt).not.toBeNull()
    const s2 = (await call('expoA', 'GET', '/expo/kitchen-status')).json()
    expect(s2.unstarted).toHaveLength(0)

    // Ticking the first card done lets the queued one onto the screen: no backlog.
    expect((await call('cookA', 'POST', `/expo/station/${grillA}/cards/${first.id}/done`)).statusCode).toBe(200)
    const s3 = (await call('expoA', 'GET', '/expo/kitchen-status')).json()
    expect(s3.backlog.tickets).toBe(0)
    for (const x of others) await call('cookA', 'POST', `/expo/station/${grillA}/cards/${x.id}/done`)
  })

  it('a held card is refused by the tick (409 CARD_ON_HOLD) and never alerted', async () => {
    const held = await lineOrder(grillA, 3, conceptA, { status: 'held' })
    await call('cookA', 'GET', `/expo/station/${grillA}/board`)
    await prisma.orderItem.updateMany({ where: { orderId: held.id }, data: { kdsShownAt: new Date(Date.now() - 120_000) } })
    expect((await call('expoA', 'GET', '/expo/kitchen-status')).json().unstarted).toHaveLength(0)
    const r = await call('cookA', 'POST', `/expo/station/${grillA}/cards/${held.id}/done`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('CARD_ON_HOLD')
    await prisma.orderItem.updateMany({ where: { orderId: held.id }, data: { status: 'bumped' } })
  })
})

// ─── Timers ──────────────────────────────────────────────────────────────────

describe('cook timers', () => {
  it('start (persisted, starts the card), several at once, + / −, stop; company B 404', async () => {
    const a = await lineOrder(grillA, 2)
    const b = await lineOrder(grillA, 1)
    const itemA = a.items[0]!.id
    const t1 = await call('cookA', 'POST', '/expo/kitchen-timers', { stationId: grillA, entryId: itemA, durationSeconds: 240 })
    expect(t1.statusCode).toBe(201)
    expect(t1.json()).toMatchObject({ tenantId: tenantA, orderId: a.id, durationSeconds: 240, label: expect.stringContaining('Wrap') })
    const t2 = await call('cookA', 'POST', '/expo/kitchen-timers', { stationId: grillA, entryId: itemA, durationSeconds: 60, label: 'Rest' })
    const t3 = await call('cookA', 'POST', '/expo/kitchen-timers', { stationId: grillA, entryId: b.items[0]!.id, durationSeconds: 90 })
    expect([t2.statusCode, t3.statusCode]).toEqual([201, 201])
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemA } })).startedAt).not.toBeNull()

    // Another tablet sees all three.
    const board = (await call('expoA', 'GET', `/expo/station/${grillA}/board`)).json()
    expect(board.timers).toHaveLength(3)
    expect(board.visible.find((c: { order: { id: string } }) => c.order.id === a.id).started).toBe(true)

    const adj = await call('cookA', 'PATCH', `/expo/kitchen-timers/${t1.json().id}`, { addSeconds: 30 })
    expect(adj.statusCode).toBe(200)
    expect(adj.json().durationSeconds).toBe(270)
    expect(new Date(adj.json().endsAt).getTime() - new Date(adj.json().startedAt).getTime()).toBe(270_000)
    expect((await call('cookA', 'PATCH', `/expo/kitchen-timers/${t2.json().id}`, { addSeconds: -60 })).statusCode).toBe(422)

    expect((await call('cookB', 'PATCH', `/expo/kitchen-timers/${t1.json().id}`, { addSeconds: 30 })).statusCode).toBe(404)
    expect((await call('cookB', 'POST', `/expo/kitchen-timers/${t1.json().id}/stop`)).statusCode).toBe(404)
    expect((await call('cookB', 'POST', '/expo/kitchen-timers', { stationId: grillA, entryId: itemA, durationSeconds: 60 })).statusCode).toBe(404)
    // A row of another station is not on this one.
    expect((await call('cookA', 'POST', '/expo/kitchen-timers', { stationId: fryA, entryId: itemA, durationSeconds: 60 })).statusCode).toBe(404)

    expect((await call('cookA', 'POST', `/expo/kitchen-timers/${t2.json().id}/stop`)).statusCode).toBe(200)
    expect((await call('cookA', 'PATCH', `/expo/kitchen-timers/${t2.json().id}`, { addSeconds: 10 })).statusCode).toBe(409)
    expect((await call('cookA', 'GET', `/expo/station/${grillA}/board`)).json().timers).toHaveLength(2)

    // The tick stops the card's timers.
    await call('cookA', 'POST', `/expo/station/${grillA}/cards/${a.id}/done`)
    await call('cookA', 'POST', `/expo/station/${grillA}/cards/${b.id}/done`)
    expect(await prisma.kitchenTimer.count({ where: { orderId: { in: [a.id, b.id] }, stoppedAt: null } })).toBe(0)
  })
})

// ─── Multi-station cascade ───────────────────────────────────────────────────

describe('multi-station cascade through the tick', () => {
  it('grill → fry: ticking at grill fires the fry step; ticking at fry bumps the dish and the order goes ready', async () => {
    const dish = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Loaded Fries', priceCents: 90_000 } })
    const recipe = await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish.id } })
    const s1 = await prisma.recipeStep.create({ data: { recipeId: recipe.id, phase: 'service_cook', stationId: grillA, instruction: 'Grill the chicken', instructionUrdu: 'چکن گرل کریں', estimatedSeconds: 300, dependsOnIds: [] } })
    await prisma.recipeStep.create({ data: { recipeId: recipe.id, phase: 'service_cook', ordinal: 1, stationId: fryA, instruction: 'Fry and load', estimatedSeconds: 180, dependsOnIds: [s1.id] } })
    n += 1
    const ord = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'received', fulfilmentType: 'dine_in', totalCents: 90_000, placedAt: new Date(),
        externalId: `kds-board-cascade-${n}`, items: { create: [{ menuItemId: dish.id, name: 'Loaded Fries', quantity: 1, unitPriceCents: 90_000 }] },
      },
    })
    expect((await call('expoA', 'POST', `/expo/orders/${ord.id}/fire`, {})).statusCode).toBe(200)

    const grill = (await call('cookA', 'GET', `/expo/station/${grillA}/board`)).json()
    const card = grill.visible.find((c: { order: { id: string } }) => c.order.id === ord.id)
    expect(card.entries[0]).toMatchObject({ kind: 'step', instruction: 'Grill the chicken', instructionUrdu: 'چکن گرل کریں', estimatedSeconds: 300 })
    const fry1 = (await call('cookA', 'GET', `/expo/station/${fryA}/board`)).json()
    expect(fry1.visible.find((c: { order: { id: string } }) => c.order.id === ord.id)).toBeUndefined()
    expect(fry1.onDeck.find((d: { order: { id: string } }) => d.order.id === ord.id)).toBeTruthy()

    // A timer on the step defaults from estimatedSeconds on the screen; the API takes any duration.
    const t = await call('cookA', 'POST', '/expo/kitchen-timers', { stationId: grillA, entryId: card.entries[0].id, durationSeconds: 300 })
    expect(t.json().orderItemStepId).toBe(card.entries[0].id)

    expect((await call('cookB', 'POST', `/expo/station/${grillA}/cards/${ord.id}/done`)).statusCode).toBe(404)
    const done1 = await call('cookA', 'POST', `/expo/station/${grillA}/cards/${ord.id}/done`)
    expect(done1.statusCode).toBe(200)
    expect(done1.json().unlocked).toEqual([expect.objectContaining({ stationId: fryA })])
    const fry2 = (await call('cookA', 'GET', `/expo/station/${fryA}/board`)).json()
    const fryCard = fry2.visible.find((c: { order: { id: string } }) => c.order.id === ord.id)
    expect(fryCard.entries[0]).toMatchObject({ kind: 'step', instruction: 'Fry and load' })
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: ord.id } })).status).toBe('preparing')

    const done2 = await call('cookA', 'POST', `/expo/station/${fryA}/cards/${ord.id}/done`)
    expect(done2.statusCode).toBe(200)
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: ord.id } })).status).toBe('bumped')
    const after = await prisma.order.findUniqueOrThrow({ where: { id: ord.id } })
    expect(after.status).toBe('ready')
  })
})

// ─── Stickers ────────────────────────────────────────────────────────────────

describe('stickers and sticker size', () => {
  it('prints N bag stickers at the company size; size is per company; company B gets 404', async () => {
    const ord = await lineOrder(grillA, 1)
    const r = await call('expoA', 'GET', `/expo/orders/${ord.id}/print?kind=sticker&bags=2`)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.body).toContain('Bag 2 of 2')
    expect(r.body).toContain('size:58mm 40mm')
    expect((await call('cookB', 'GET', `/expo/orders/${ord.id}/print?kind=sticker&bags=2`)).statusCode).toBe(404)
    expect((await call('expoA', 'GET', `/expo/orders/${ord.id}/print?kind=sticker&bags=21`)).statusCode).toBe(400)

    expect((await call('cookA', 'PUT', '/expo/label-settings', { widthMm: 102, heightMm: 76 })).statusCode).toBe(403)
    expect((await call('expoA', 'PUT', '/expo/label-settings', { widthMm: 102, heightMm: 76 })).statusCode).toBe(200)
    expect((await call('expoA', 'GET', '/expo/label-settings')).json()).toMatchObject({ widthMm: 102, heightMm: 76 })
    expect((await call('mgrB', 'GET', '/expo/label-settings')).json()).toMatchObject({ widthMm: 58, heightMm: 40 })
    const r2 = await call('expoA', 'GET', `/expo/orders/${ord.id}/print?kind=ticket`)
    expect(r2.body).toContain('not a bill')
    expect((await call('expoA', 'GET', `/expo/orders/${ord.id}/print?kind=sticker`)).body).toContain('size:102mm 76mm')
    await call('cookA', 'POST', `/expo/station/${grillA}/cards/${ord.id}/done`)
  })
})
