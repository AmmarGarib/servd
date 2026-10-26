// Owner C10 (2026-10-26): "overbooking should auto come to ceo for approval.
// Manager shouldnt be able to do that without approval."
//
//   • A manager's (or a host-with-PIN's) booking past capacity is stored as
//     pending_approval (202): off the floor / capacity, the guest told nothing.
//   • It is in the CEO's approvals inbox (type reservation_overbook) and the
//     CEO's bell; company B's CEO never sees or decides it (404).
//   • Approve → booked + the normal confirmation; reject (note ≥10) →
//     cancelled + the polite "fully booked" message.
//   • The CEO's own overbook books at once (201) and confirms at once.
//   • A change of a live booking past capacity waits; the booking stays as it
//     was until approved; one pending per booking (409 OVERBOOK_PENDING).
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'

const sent = vi.hoisted(() => ({ phone: [] as Array<{ to: string; body: string; purpose: string }>, email: [] as Array<{ to: string; subject: string; purpose: string }> }))
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendPhoneMessage: vi.fn(async (to: string, body: string, purpose: string) => { sent.phone.push({ to, body, purpose }) }),
  sendEmail: vi.fn(async (to: string, subject: string, _html: string, purpose: string) => { sent.email.push({ to, subject, purpose }) }),
}))

import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { reservationRoutes } from '../src/modules/reservations/routes.js'
import { approvalSubject } from '../src/lib/approvalRights.js'
import { flushNotifications } from '../src/lib/staffNotify.js'
import { prisma, mkCompany, mkUser, caller, type Company, type Who } from './connectorsFixtures.js'

const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')

const DAY = 86_400_000
let app: FastifyInstance
let A: Company, B: Company
let hostA: Who, mgrA: Who, ceoA: Who, ceoB: Who, mgrB: Who
let tA4 = ''
const PIN_A = '614372'
const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)
const R = '/api/v1/reservations'

const slot = (hoursUtc = 15) => {
  const d = new Date(Date.now() + 2 * DAY)
  d.setUTCHours(hoursUtc, 0, 0, 0)
  return d.toISOString()
}
const book = (who: Who, extra: Record<string, unknown> = {}, co: Company = A) =>
  call(who, 'POST', R, { conceptId: co.conceptId, partySize: 4, startTime: slot(), guestName: 'Sana Iqbal', guestPhone: '03004445556', guestEmail: 'sana@example.com', ...extra })

beforeAll(async () => {
  const k = Date.now().toString(36)
  A = await mkCompany(`ob-a-${k}`)
  B = await mkCompany(`ob-b-${k}`)
  hostA = await mkUser('ob-host-a', 'foh', A.tenantId)
  mgrA = await mkUser('ob-mgr-a', 'foh_management', A.tenantId)
  ceoA = await mkUser('ob-ceo-a', 'admin', A.tenantId)
  ceoB = await mkUser('ob-ceo-b', 'admin', B.tenantId)
  mgrB = await mkUser('ob-mgr-b', 'foh_management', B.tenantId)
  const { setManagerPin } = await import('../src/modules/auth/managerPin.js')
  await setManagerPin(mgrA.id, PIN_A)
  tA4 = (await prisma.table.create({ data: { conceptId: A.conceptId, label: 'A4', capacity: 4 } })).id
  await prisma.table.create({ data: { conceptId: B.conceptId, label: 'B4', capacity: 4 } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(reservationRoutes, { prefix: '/reservations' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()

  // Fill A's and B's only 4-top at the slot.
  expect((await book(hostA, { guestName: 'First A', guestPhone: null, guestEmail: null })).statusCode).toBe(201)
  expect((await book(mgrB, { guestName: 'First B', guestPhone: null, guestEmail: null }, B)).statusCode).toBe(201)
}, 60_000)

afterAll(async () => { await app?.close() })
beforeEach(() => { sent.phone.length = 0; sent.email.length = 0 })

describe('C10 — a manager’s overbook waits for the CEO', () => {
  let resId = ''
  let reqId = ''

  it('stored pending_approval (202), no table, the guest told nothing', async () => {
    const r = await book(hostA, { overbook: true, overbookReason: 'regular, tables pushed', managerOverridePin: PIN_A })
    expect(r.statusCode, r.body).toBe(202)
    expect(r.json()).toMatchObject({ pendingApproval: true, status: 'pending_approval', overbooked: true, tableId: null })
    resId = r.json().id
    reqId = r.json().overbookRequestId
    const row = await prisma.reservationOverbookRequest.findUniqueOrThrow({ where: { id: reqId } })
    expect(row).toMatchObject({ tenantId: A.tenantId, kind: 'create', status: 'pending', managerApproverId: mgrA.id, viaPin: true, requestedById: hostA.id })
    expect(sent.phone).toHaveLength(0)
    expect(sent.email).toHaveLength(0)
    expect(await approvalSubject('reservation_overbook', reqId)).toMatchObject({ ownerTenantId: A.tenantId, status: 'pending' })
  })

  it('it is not on the floor: a normal party for the same slot is still SLOT_FULL only for the real booking, the waiting one is not counted', async () => {
    // The 4-top is taken by "First A"; the waiting booking holds nothing more (no table, not in capacity).
    const two = await book(hostA, { partySize: 4, guestName: 'Third', guestPhone: null, guestEmail: null })
    expect(two.statusCode).toBe(409)
    const live = await prisma.reservation.count({ where: { conceptId: A.conceptId, status: { in: ['booked', 'confirmed', 'seated'] } } })
    expect(live).toBe(1)
  })

  it('while it waits it cannot be confirmed, seated or edited (409 OVERBOOK_PENDING)', async () => {
    for (const [m, url, body] of [
      ['POST', `${R}/${resId}/confirm`, {}],
      ['POST', `${R}/${resId}/seat`, { tableId: tA4 }],
      ['PUT', `${R}/${resId}`, {}],
    ] as const) {
      if (m === 'PUT') {
        const p = await app.inject({ method: 'PATCH', url, payload: { guestName: 'Renamed' }, headers: { authorization: `Bearer ${mgrA.token}` } })
        expect(p.json().error.code).toBe('OVERBOOK_PENDING')
      } else {
        const res = await call(mgrA, m, url, body)
        expect(res.statusCode).toBe(409)
        expect(res.json().error.code).toBe('OVERBOOK_PENDING')
      }
    }
  })

  it('the CEO of A sees it in the inbox and on the bell; B’s CEO cannot see or decide it; the manager cannot approve', async () => {
    await flushNotifications()
    const bell = await prisma.staffNotification.findFirst({ where: { userId: ceoA.id, entityId: reqId } })
    expect(bell).not.toBeNull()
    expect(await prisma.staffNotification.count({ where: { userId: ceoB.id, entityId: reqId } })).toBe(0)

    const inboxA = (await call(ceoA, 'GET', '/api/v1/approvals?type=reservation_overbook')).json() as { items: Array<{ id: string; type: string }> }
    expect(inboxA.items.map((i) => i.id)).toContain(reqId)
    const inboxB = (await call(ceoB, 'GET', '/api/v1/approvals?type=reservation_overbook')).json() as { items: Array<{ id: string }> }
    expect(inboxB.items.map((i) => i.id)).not.toContain(reqId)

    expect((await call(ceoB, 'POST', `${R}/overbook-requests/${reqId}/approve`, {})).statusCode).toBe(404)
    expect((await call(mgrA, 'POST', `${R}/overbook-requests/${reqId}/approve`, {})).statusCode).toBe(403)
  })

  it('the CEO approves → booked, and only now the guest gets the confirmation', async () => {
    const ok = await call(ceoA, 'POST', `${R}/overbook-requests/${reqId}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: resId } })).status).toBe('booked')
    expect(sent.phone.map((m) => m.purpose)).toEqual(['reservation.confirmed'])
    expect(sent.email.map((m) => m.purpose)).toEqual(['reservation.confirmed'])
    const log = await prisma.auditLog.findFirst({ where: { action: 'reservation.overbook', entityId: resId } })
    expect(log?.metadata).toMatchObject({ approverId: ceoA.id, requestId: reqId })
    expect((await call(ceoA, 'POST', `${R}/overbook-requests/${reqId}/approve`, {})).statusCode).toBe(409)
  })

  it('reject needs a note ≥10; a rejected booking is cancelled and the guest told politely the time is full', async () => {
    const r = await book(mgrA, { guestName: 'Late Group', guestPhone: '03001112223', guestEmail: 'late@example.com', overbook: true, overbookReason: 'big birthday' })
    expect(r.statusCode).toBe(202)
    sent.phone.length = 0; sent.email.length = 0
    const id = r.json().overbookRequestId
    expect((await call(ceoA, 'POST', `${R}/overbook-requests/${id}/reject`, { note: 'no' })).statusCode).toBe(400)
    const no = await call(ceoA, 'POST', `${R}/overbook-requests/${id}/reject`, { note: 'the floor is already too tight' })
    expect(no.statusCode).toBe(200)
    expect(no.json().bookingCancelled).toBe(true)
    const res = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(res.status).toBe('cancelled')
    expect(sent.phone).toHaveLength(1)
    expect(sent.phone[0]!.body).toMatch(/fully booked/)
    expect(sent.phone[0]!.body).not.toMatch(/tight/) // never the CEO's note
    expect(sent.email.map((m) => m.purpose)).toEqual(['reservation.cancelled'])
  })

  it('staff cancelling a waiting booking withdraws the request', async () => {
    const r = await book(mgrA, { guestName: 'Withdrawn', guestPhone: null, guestEmail: null, overbook: true, overbookReason: 'squeeze them in' })
    expect(r.statusCode).toBe(202)
    expect((await call(mgrA, 'POST', `${R}/${r.json().id}/cancel`, { reason: 'guest changed plans' })).statusCode).toBe(200)
    expect((await prisma.reservationOverbookRequest.findUniqueOrThrow({ where: { id: r.json().overbookRequestId } })).status).toBe('cancelled')
  })
})

describe('C10 — the CEO’s own overbook applies at once', () => {
  it('201, booked, confirmed to the guest, no request', async () => {
    const r = await book(ceoA, { guestName: 'CEO guest', overbook: true, overbookReason: 'friend of the house' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ status: 'booked', overbooked: true })
    expect(r.json().pendingApproval).toBeUndefined()
    expect(await prisma.reservationOverbookRequest.count({ where: { reservationId: r.json().id } })).toBe(0)
    expect(sent.phone.map((m) => m.purpose)).toEqual(['reservation.confirmed'])
  })
})

describe('C10 — a change past capacity waits; the booking stays as it was', () => {
  it('manager edit → 202, booking unchanged; one pending per booking; CEO approval applies it', async () => {
    // A party of 2 on its own; growing it to 6 fits no table.
    const small = await book(mgrA, { partySize: 2, startTime: slot(18), guestName: 'Small', guestPhone: null, guestEmail: null })
    expect(small.statusCode).toBe(201)
    const id = small.json().id
    const patch = (who: Who, payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `${R}/${id}`, payload, headers: { authorization: `Bearer ${who.token}` } })
    const edit = await patch(mgrA, { partySize: 6, tableId: null, overbook: true, overbookReason: 'two more friends coming' })
    expect(edit.statusCode, edit.body).toBe(202)
    expect(edit.json().pendingApproval).toBe(true)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id } })).partySize).toBe(2)
    expect((await patch(mgrA, { guestName: 'Other' })).json().error.code).toBe('OVERBOOK_PENDING')

    const ok = await call(ceoA, 'POST', `${R}/overbook-requests/${edit.json().overbookRequestId}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id } })
    expect(after.partySize).toBe(6)
    expect(after.status).toBe('booked')
    expect(after.notes).toMatch(/Overbooked: two more friends coming/)
  })
})

describe('C10 — company B', () => {
  it('B’s manager overbook binds to B and only B’s CEO decides it', async () => {
    const r = await book(mgrB, { guestName: 'B over', overbook: true, overbookReason: 'tables pushed together' }, B)
    expect(r.statusCode, r.body).toBe(202)
    const id = r.json().overbookRequestId
    expect((await prisma.reservationOverbookRequest.findUniqueOrThrow({ where: { id } })).tenantId).toBe(B.tenantId)
    expect((await call(ceoA, 'POST', `${R}/overbook-requests/${id}/reject`, { note: 'not my company at all' })).statusCode).toBe(404)
    const listA = (await call(ceoA, 'GET', `${R}/overbook-requests?status=pending`)).json() as { items: Array<{ id: string }> }
    expect(listA.items.map((i) => i.id)).not.toContain(id)
    expect((await call(ceoB, 'POST', `${R}/overbook-requests/${id}/approve`, {})).statusCode).toBe(200)
  })
})
