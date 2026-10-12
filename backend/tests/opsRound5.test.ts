// Ops round 5 (stream O) — regression tests.
//
//   ONL-R2-04 UI  the host's "booking past capacity" prompt. The server answers
//                 409 SLOT_FULL { overbookAllowed, managerRequired }; the admin
//                 dialog (frontend/admin/src/app/reservations/overbook.ts) reads
//                 it, asks for a reason (and a manager PIN when needed), resends
//                 with { overbook, overbookReason, managerOverridePin } and
//                 shows the table it got. PIN refusals in the petty-cash words.
//                 Two companies: B's manager PIN never approves A's booking, and
//                 B cannot book into A's brand at all.
//   SMTP at rest  PUT /auth/integrations/email encrypts the password with
//                 SERVD_SECRET_KEY (lib/secretBox), a plain one is encrypted
//                 on first read, and WITHOUT the key saving still works in plain
//                 text and says so. GET never returns the password. /health
//                 smtpPassAtRest mirrors whatsappKeyAtRest.
//   O-RV-1        the New booking sheets clear the reservation policy: the
//                 tablet sheet's default slot is now + the company's notice
//                 period, rounded up to the quarter hour (with a date, rolling
//                 to tomorrow at night) — the real route answers 201 or the
//                 SLOT_FULL prompt, never TOO_SOON; TOO_SOON / TOO_FAR /
//                 PARTY_TOO_LARGE / WALKINS_DISABLED in plain words. The
//                 tablet's helper block is lifted out of the .tsx and run.
//   O-RV-2        totals-mismatch advice: a refund's Retry cannot rebuild it,
//                 and an in-doubt row (no lookup on this fiscal POS) never
//                 tells anyone to file by hand before the vendor confirms.
//   NEEDS 23      the fiscal screens: heldNote / the reporting-switch answer
//                 typed and shown, REPORTING_OFF / NOT_LIVE / TOTALS_MISMATCH
//                 in plain words, totals-mismatch documents marked with what
//                 to do (frontend/admin/src/lib/connectorsApi.ts).
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { reservationRoutes } from '../src/modules/reservations/routes.js'
import { setupRoutes } from '../src/modules/setup/routes.js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { testFiscalDriver } from '../src/connectors/drivers/test.js'
import { transformSync } from 'esbuild'
import { authRoutes } from '../src/modules/auth/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import {
  SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY,
  mailConfig, invalidateMailConfig, smtpSecretHealth, smtpPassView, sealSmtpPass,
} from '../src/lib/mailer.js'
import { decryptSecret } from '../src/lib/secretBox.js'
import { prisma, mkCompany, mkUser, caller, setConnector, mkOrder, TEST_SECRET_KEY, type Company, type Who } from './connectorsFixtures.js'

// The admin's own helpers, loaded as-is (no React).
const { ApiError } = await import('../../frontend/admin/src/lib/api.ts')
const ob = await import('../../frontend/admin/src/app/reservations/overbook.ts')
const conn = await import('../../frontend/admin/src/lib/connectorsApi.ts')
const { WRONG_PIN_MESSAGE } = await import('../../frontend/admin/src/components/pos/pinErrors.ts')

const DAY = 86_400_000
let app: FastifyInstance
let A: Company, B: Company
let hostA: Who, mgrA: Who, hostB: Who, mgrB: Who, ceoA: Who, ceoB: Who, itA: Who
const PIN_A = '5172'
const PIN_B = '9364'
const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)
const prevSecretKey = process.env['SERVD_SECRET_KEY']
const prevSmtpPass = process.env['SMTP_PASS']

/** What the admin API client makes of a failed response (lib/api.ts errorFrom). */
function toApiError(res: LightMyRequestResponse): InstanceType<typeof ApiError> {
  const data = res.json() as { error?: { code?: string; message?: string; details?: unknown } }
  return new ApiError(res.statusCode, data.error?.code ?? 'HTTP_ERROR', data.error?.message ?? 'Request failed', data.error?.details)
}

beforeAll(async () => {
  const s = Date.now().toString(36)
  A = await mkCompany(`ops5-a-${s}`)
  B = await mkCompany(`ops5-b-${s}`)
  hostA = await mkUser('ops5-host-a', 'foh', A.tenantId)
  mgrA = await mkUser('ops5-mgr-a', 'foh_management', A.tenantId)
  hostB = await mkUser('ops5-host-b', 'foh', B.tenantId)
  mgrB = await mkUser('ops5-mgr-b', 'foh_management', B.tenantId)
  ceoA = await mkUser('ops5-ceo-a', 'admin', A.tenantId)
  ceoB = await mkUser('ops5-ceo-b', 'admin', B.tenantId)
  itA = await mkUser('ops5-it-a', 'it', A.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  await setManagerPin(mgrB.id, PIN_B)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await registerConnectorPlugins(app)
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await prisma.setting.deleteMany({ where: { key: { in: [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY] } } })
  invalidateMailConfig()
  if (prevSecretKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevSecretKey
  if (prevSmtpPass === undefined) delete process.env['SMTP_PASS']
  else process.env['SMTP_PASS'] = prevSmtpPass
})

// ─── ONL-R2-04 — the overbook prompt ─────────────────────────────────────────

describe('ONL-R2-04 UI — the admin dialog’s overbook helpers', () => {
  it('reads SLOT_FULL only when an overbook is allowed; managerRequired defaults to asking for the PIN', () => {
    expect(ob.slotFullPrompt(new ApiError(409, 'SLOT_FULL', 'No table for 4', { overbookAllowed: true, managerRequired: true })))
      .toEqual({ message: 'No table for 4', managerRequired: true })
    expect(ob.slotFullPrompt(new ApiError(409, 'SLOT_FULL', 'x', { overbookAllowed: true, managerRequired: false }))?.managerRequired).toBe(false)
    expect(ob.slotFullPrompt(new ApiError(409, 'SLOT_FULL', 'x', { overbookAllowed: true }))?.managerRequired).toBe(true)
    // The public form's SLOT_FULL carries no overbook — no prompt.
    expect(ob.slotFullPrompt(new ApiError(409, 'SLOT_FULL', 'x'))).toBeNull()
    expect(ob.slotFullPrompt(new ApiError(409, 'TABLE_CONFLICT', 'x', { overbookAllowed: true }))).toBeNull()
    expect(ob.slotFullPrompt(new Error('SLOT_FULL'))).toBeNull()
  })

  it('needs a 3+ character reason, and a 4–8 character PIN only when a manager is required', () => {
    expect(ob.overbookReady('ab', '1234', true)).toBe(false)
    expect(ob.overbookReady('  regular  ', '', true)).toBe(false)
    expect(ob.overbookReady('regular', '123', true)).toBe(false)
    expect(ob.overbookReady('regular', '123456789', true)).toBe(false)
    expect(ob.overbookReady('regular', '1234', true)).toBe(true)
    expect(ob.overbookReady('regular', '', false)).toBe(true)
    expect(ob.overbookReady('x'.repeat(301), '', false)).toBe(false)
  })

  it('sends the server’s exact field names, and no PIN when the user is a manager', () => {
    expect(ob.overbookFields(' tables pushed ', ' 1234 ', true)).toEqual({ overbook: true, overbookReason: 'tables pushed', managerOverridePin: '1234' })
    expect(ob.overbookFields('tables pushed', '1234', false)).toEqual({ overbook: true, overbookReason: 'tables pushed' })
  })

  it('words PIN refusals like every other PIN prompt (petty cash, voids)', () => {
    expect(ob.overbookRefusalText(new ApiError(403, 'INVALID_MANAGER_PIN', 'That PIN does not belong…'))).toBe(WRONG_PIN_MESSAGE)
    expect(ob.overbookRefusalText(new ApiError(429, 'MANAGER_PIN_LOCKED', 'locked', { retryAfterSec: 125 })))
      .toBe('Too many wrong PINs. A manager must sign in, or try again in 3 minutes.')
    expect(ob.overbookRefusalText(new ApiError(403, 'MANAGER_OVERRIDE_REQUIRED', 'x'))).toMatch(/needs a manager/)
    expect(ob.overbookRefusalText(new ApiError(409, 'SLOT_FULL', 'x'))).toBeNull()
  })

  it('says which table the booking got, or that it has none yet', () => {
    expect(ob.bookedLine({ table: { id: 't', label: 'T4' }, overbooked: false })).toBe('Booked — table T4.')
    expect(ob.bookedLine({ table: null, overbooked: true })).toMatch(/past capacity — no table is assigned yet/)
    expect(ob.bookedLine({ table: { id: 't', label: 'T2' }, overbooked: true })).toMatch(/past capacity on table T2/)
    expect(ob.bookedLine({ table: null, waitlist: true })).toMatch(/waiting list/)
  })
})

describe('ONL-R2-04 UI — the dialog against the real route (two companies)', () => {
  const slot = () => {
    const d = new Date(Date.now() + 2 * DAY)
    d.setUTCHours(14, 0, 0, 0)
    return d.toISOString()
  }
  // The admin dialog's body (page.tsx NewReservationModal).
  const body = (co: Company, extra: Record<string, unknown> = {}) => ({
    conceptId: co.conceptId, partySize: 4, startTime: slot(), durationMin: 90, tableId: null, waitlist: false,
    guestName: 'Sana Iqbal', guestPhone: null, guestEmail: null, notes: null, isVip: false, source: 'staff', ...extra,
  })

  beforeAll(async () => {
    await prisma.table.create({ data: { conceptId: A.conceptId, label: 'A4', capacity: 4 } })
    await prisma.table.create({ data: { conceptId: B.conceptId, label: 'B4', capacity: 4 } })
  })

  it('first booking gets the 4-top and the dialog names it; the next is SLOT_FULL asking for a manager PIN', async () => {
    const first = await call(hostA, 'POST', '/reservations', body(A))
    expect(first.statusCode, first.body).toBe(201)
    expect(ob.bookedLine(first.json())).toBe('Booked — table A4.')

    const before = await prisma.reservation.count({ where: { conceptId: A.conceptId } })
    const second = await call(hostA, 'POST', '/reservations', body(A, { guestName: 'Second' }))
    expect(second.statusCode).toBe(409)
    const prompt = ob.slotFullPrompt(toApiError(second))
    expect(prompt).toMatchObject({ managerRequired: true })
    expect(prompt!.message).toMatch(/No table for 4/)
    expect(await prisma.reservation.count({ where: { conceptId: A.conceptId } })).toBe(before)
  })

  it('another company’s manager PIN is refused in plain words and stores nothing; the right PIN books past capacity', async () => {
    const before = await prisma.reservation.count({ where: { conceptId: A.conceptId } })
    const wrong = await call(hostA, 'POST', '/reservations', body(A, { guestName: 'Squeeze', ...ob.overbookFields('regular, tables pushed', PIN_B, true) }))
    expect(wrong.statusCode).toBe(403)
    expect(ob.overbookRefusalText(toApiError(wrong))).toBe(WRONG_PIN_MESSAGE)
    expect(await prisma.reservation.count({ where: { conceptId: A.conceptId } })).toBe(before)

    const ok = await call(hostA, 'POST', '/reservations', body(A, { guestName: 'Squeeze', ...ob.overbookFields('regular, tables pushed', PIN_A, true) }))
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json()).toMatchObject({ overbooked: true, tableId: null })
    expect(ob.bookedLine(ok.json())).toMatch(/past capacity — no table is assigned yet/)
    const log = await prisma.auditLog.findFirst({ where: { action: 'reservation.overbook', entityId: ok.json().id } })
    expect(log?.metadata).toMatchObject({ reason: 'regular, tables pushed', approverId: mgrA.id, viaPin: true })
  })

  it('a manager’s own login: SLOT_FULL says no PIN is needed, and the overbook goes through without one', async () => {
    const full = await call(mgrA, 'POST', '/reservations', body(A, { guestName: 'Mgr' }))
    expect(full.statusCode).toBe(409)
    const prompt = ob.slotFullPrompt(toApiError(full))
    expect(prompt?.managerRequired).toBe(false)
    const ok = await call(mgrA, 'POST', '/reservations', body(A, { guestName: 'Mgr', ...ob.overbookFields('birthday group', '', prompt!.managerRequired) }))
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().overbooked).toBe(true)
  })

  it('a host without a PIN gets MANAGER_OVERRIDE_REQUIRED in plain words', async () => {
    const r = await call(hostA, 'POST', '/reservations', body(A, { guestName: 'NoPin', overbook: true, overbookReason: 'regular' }))
    expect(r.statusCode).toBe(403)
    expect(ob.overbookRefusalText(toApiError(r))).toMatch(/needs a manager/)
  })

  it('company B cannot book into A’s brand (404), and B’s own booking binds to B with B’s table', async () => {
    const foreign = await call(hostB, 'POST', '/reservations', body(A, { ...ob.overbookFields('x-company', PIN_A, true) }))
    expect(foreign.statusCode).toBe(404)
    const own = await call(hostB, 'POST', '/reservations', body(B))
    expect(own.statusCode, own.body).toBe(201)
    expect(ob.bookedLine(own.json())).toBe('Booked — table B4.')
    expect(own.json().concept.tenantId).toBe(B.tenantId)
    // B's manager PIN approves B's overbook only.
    const over = await call(hostB, 'POST', '/reservations', body(B, { guestName: 'B over', ...ob.overbookFields('two tops pushed', PIN_B, true) }))
    expect(over.statusCode, over.body).toBe(201)
    expect(over.json().overbooked).toBe(true)
  })
})

// ─── O-RV-1 — the New booking sheets clear the reservation policy ───────────

// The tablet sheet's pure helpers, lifted out of the .tsx verbatim (no React
// Native in a Node test) and run as they are.
type SlotFn = (minAdvanceHours: number, nowMs?: number) => { date: string; time: string }
const tabletHelpers = (() => {
  const src = readFileSync(new URL('../../tablet/app/(staff)/reservations.tsx', import.meta.url), 'utf8')
  const start = src.indexOf('// <booking-policy-helpers>')
  const end = src.indexOf('// </booking-policy-helpers>')
  if (start < 0 || end < start) throw new Error('booking-policy-helpers block not found in the tablet sheet')
  const js = transformSync(src.slice(start, end), { loader: 'ts' }).code
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${js}\nreturn { defaultBookingSlot, bookingStartIso, policyRefusalText, DEFAULT_MIN_ADVANCE_HOURS }`)() as {
    defaultBookingSlot: SlotFn
    bookingStartIso: (date: string, time: string) => string | null
    policyRefusalText: (code: string, message: string, opts?: { minAdvanceHours?: number | null; canWalkIn?: boolean }) => string | null
    DEFAULT_MIN_ADVANCE_HOURS: number
  }
})()

describe('O-RV-1 — the booking sheets’ default slot and policy words (pure)', () => {
  const pkt = (s: string) => new Date(`${s}+05:00`).getTime()

  it('default slot = now + notice + 5 min slack, rounded UP to the quarter hour, Karachi date and time', () => {
    for (const slot of [tabletHelpers.defaultBookingSlot, ob.defaultBookingSlot as SlotFn]) {
      expect(slot(2, pkt('2026-10-12T10:07:00'))).toEqual({ date: '2026-10-12', time: '12:15' })
      expect(slot(2, pkt('2026-10-12T10:10:00'))).toEqual({ date: '2026-10-12', time: '12:15' })
      expect(slot(2, pkt('2026-10-12T10:10:01'))).toEqual({ date: '2026-10-12', time: '12:30' })
      // Late at night it rolls to tomorrow — never capped at 23:45 in the past.
      expect(slot(2, pkt('2026-10-12T22:40:00'))).toEqual({ date: '2026-10-13', time: '00:45' })
      expect(slot(0, pkt('2026-10-12T23:56:00'))).toEqual({ date: '2026-10-13', time: '00:15' })
      expect(slot(24, pkt('2026-12-31T20:00:00'))).toEqual({ date: '2027-01-01', time: '20:15' })
      // A broken policy value never throws or goes backwards.
      expect(slot(Number.NaN, pkt('2026-10-12T10:07:00'))).toEqual({ date: '2026-10-12', time: '10:15' })
    }
    expect(tabletHelpers.DEFAULT_MIN_ADVANCE_HOURS).toBe(2)
  })

  it('the tablet reads a Karachi date + time, and refuses what is not a real one', () => {
    const iso = tabletHelpers.bookingStartIso
    expect(iso('2026-10-13', '19:30')).toBe('2026-10-13T14:30:00.000Z')
    expect(iso('2026-10-13', '00:15')).toBe('2026-10-12T19:15:00.000Z')
    expect(iso('2026-02-31', '19:30')).toBeNull()
    expect(iso('2026-10-13', '24:00')).toBeNull()
    expect(iso('2026-1-3', '19:30')).toBeNull()
    expect(iso('', '')).toBeNull()
  })

  it('TOO_SOON / TOO_FAR / PARTY_TOO_LARGE / WALKINS_DISABLED in plain words — the same on the tablet and the admin', () => {
    const cases: Array<[string, string]> = [
      ['TOO_SOON', 'Reservations must be made at least 2 hours in advance.'],
      ['TOO_FAR', 'Reservations cannot be made more than 60 days ahead.'],
      ['PARTY_TOO_LARGE', 'Maximum party size is 20. Contact the venue for larger groups.'],
      ['WALKINS_DISABLED', 'Walk-ins are currently not accepted. Please book in advance.'],
    ]
    for (const [code, message] of cases) {
      const admin = ob.policyRefusalText(new ApiError(400, code, message), { canWalkIn: true })
      expect(admin).toBeTruthy()
      expect(tabletHelpers.policyRefusalText(code, message, { canWalkIn: true })).toBe(admin)
    }
    expect(tabletHelpers.policyRefusalText('TOO_SOON', 'at least 2 hours', { canWalkIn: true }))
      .toBe('Bookings need at least 2 hours’ notice — pick a later time, or tick Walk-in for a party being seated now.')
    // The admin dialog has no walk-in tick, so it never mentions one.
    expect(ob.policyRefusalText(new ApiError(400, 'TOO_SOON', 'at least 1 hours'))).toBe('Bookings need at least 1 hour’ notice — pick a later time.')
    // The loaded policy wins over the server's sentence.
    expect(tabletHelpers.policyRefusalText('TOO_SOON', 'whatever', { minAdvanceHours: 5 })).toMatch(/at least 5 hours/)
    expect(ob.policyRefusalText(new ApiError(400, 'TOO_FAR', 'x'))).toMatch(/Pick an earlier date/)
    expect(ob.policyRefusalText(new ApiError(400, 'PARTY_TOO_LARGE', 'Maximum party size is 20.'))).toMatch(/at most 20.*Split it/)
    expect(ob.policyRefusalText(new ApiError(400, 'WALKINS_DISABLED', 'x'))).toMatch(/untick Walk-in/)
    // Anything else is not a policy refusal.
    expect(ob.policyRefusalText(new ApiError(409, 'SLOT_FULL', 'x'))).toBeNull()
    expect(ob.policyRefusalText(new Error('x'))).toBeNull()
    expect(tabletHelpers.policyRefusalText('SLOT_FULL', 'x')).toBeNull()
  })
})

describe('O-RV-1 — the tablet sheet’s default booking against the real route (two companies)', () => {
  // The tablet sheet's body (NewBookingSheet in tablet/app/(staff)/reservations.tsx).
  const sheetBody = (co: Company, slot: { date: string; time: string } | 'walkin', extra: Record<string, unknown> = {}) => ({
    conceptId: co.conceptId,
    partySize: 2,
    startTime: slot === 'walkin' ? new Date().toISOString() : tabletHelpers.bookingStartIso(slot.date, slot.time),
    durationMin: 90,
    guestName: 'Phone guest',
    guestPhone: null,
    notes: null,
    source: slot === 'walkin' ? 'walkin' : 'staff',
    ...extra,
  })
  const policyOf = async (who: Who) => {
    const r = await call(who, 'GET', '/setup/reservation-policy')
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as { minAdvanceHours: number; maxAdvanceDays: number; maxPartySize: number; walkInsAllowed: boolean }
  }
  const patchPolicy = async (who: Who, data: Record<string, unknown>) => {
    const r = await app.inject({ method: 'PATCH', url: '/setup/reservation-policy', payload: data, headers: { authorization: `Bearer ${who.token}` } })
    expect(r.statusCode, r.body).toBe(200)
  }
  /** 201, or the SLOT_FULL prompt the sheet was built for — never a policy refusal. */
  const expectBookedOrPrompt = (res: LightMyRequestResponse) => {
    if (res.statusCode === 201) return
    expect(res.statusCode, res.body).toBe(409)
    expect(ob.slotFullPrompt(toApiError(res))).not.toBeNull()
  }

  beforeAll(async () => {
    // A asks 5 hours' notice; B keeps the default 2. Each company's own policy.
    await patchPolicy(ceoA, { minAdvanceHours: 5 })
  })
  afterAll(async () => {
    await patchPolicy(ceoA, { minAdvanceHours: 2, walkInsAllowed: true })
  })

  it('the host reads its own company’s notice period (A 5 hours, B the default 2)', async () => {
    expect((await policyOf(hostA)).minAdvanceHours).toBe(5)
    expect((await policyOf(hostB)).minAdvanceHours).toBe(tabletHelpers.DEFAULT_MIN_ADVANCE_HOURS)
  })

  it('the sheet’s default slot books (or prompts for an overbook) — never TOO_SOON — in both companies', async () => {
    for (const [co, host] of [[A, hostA], [B, hostB]] as const) {
      const { minAdvanceHours } = await policyOf(host)
      const res = await call(host, 'POST', '/reservations', sheetBody(co, tabletHelpers.defaultBookingSlot(minAdvanceHours), { guestName: `Default ${co.tenantId.slice(-4)}` }))
      expect(res.json().error?.code).not.toBe('TOO_SOON')
      expectBookedOrPrompt(res)
      // The form left open for four minutes still clears the notice period.
      const late = await call(host, 'POST', '/reservations', sheetBody(co, tabletHelpers.defaultBookingSlot(minAdvanceHours, Date.now() - 4 * 60_000), { guestName: 'Slow typist' }))
      expect(late.json().error?.code).not.toBe('TOO_SOON')
      expectBookedOrPrompt(late)
      // Tomorrow evening (the date field) books too.
      const tomorrow = new Date(Date.now() + 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10)
      expectBookedOrPrompt(await call(host, 'POST', '/reservations', sheetBody(co, { date: tomorrow, time: '19:30' }, { guestName: 'Tomorrow' })))
    }
  })

  it('the old default (the next quarter hour today) is TOO_SOON — shown in plain words with the walk-in way out', async () => {
    const soon = tabletHelpers.defaultBookingSlot(0)
    const res = await call(hostA, 'POST', '/reservations', sheetBody(A, soon))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('TOO_SOON')
    const e = res.json().error as { code: string; message: string }
    expect(tabletHelpers.policyRefusalText(e.code, e.message, { minAdvanceHours: 5, canWalkIn: true }))
      .toBe('Bookings need at least 5 hours’ notice — pick a later time, or tick Walk-in for a party being seated now.')
    // B's default notice (2 h) is too soon for A (5 h): the policy is the brand's own company's.
    const bSlot = tabletHelpers.defaultBookingSlot(2)
    expect((await call(hostA, 'POST', '/reservations', sheetBody(A, bSlot))).json().error?.code).toBe('TOO_SOON')
    expectBookedOrPrompt(await call(hostB, 'POST', '/reservations', sheetBody(B, bSlot, { guestName: 'B two hours' })))
  })

  it('a walk-in skips the notice period; with walk-ins off it is WALKINS_DISABLED in plain words (A only)', async () => {
    expectBookedOrPrompt(await call(hostA, 'POST', '/reservations', sheetBody(A, 'walkin', { guestName: 'Walk-in A' })))
    await patchPolicy(ceoA, { walkInsAllowed: false })
    const off = await call(hostA, 'POST', '/reservations', sheetBody(A, 'walkin'))
    expect(off.statusCode).toBe(400)
    const e = off.json().error as { code: string; message: string }
    expect(e.code).toBe('WALKINS_DISABLED')
    expect(tabletHelpers.policyRefusalText(e.code, e.message, { canWalkIn: true })).toMatch(/Walk-ins are switched off/)
    // B's walk-ins are untouched by A's switch.
    expectBookedOrPrompt(await call(hostB, 'POST', '/reservations', sheetBody(B, 'walkin', { guestName: 'Walk-in B' })))
    await patchPolicy(ceoA, { walkInsAllowed: true })
  })

  it('PARTY_TOO_LARGE and TOO_FAR come back in plain words', async () => {
    const big = await call(hostB, 'POST', '/reservations', sheetBody(B, tabletHelpers.defaultBookingSlot(2), { partySize: 21 }))
    expect(big.statusCode).toBe(400)
    const eb = big.json().error as { code: string; message: string }
    expect(tabletHelpers.policyRefusalText(eb.code, eb.message)).toMatch(/at most 20/)
    const farDate = new Date(Date.now() + 5 * 3_600_000 + 61 * 86_400_000).toISOString().slice(0, 10)
    const far = await call(hostB, 'POST', '/reservations', sheetBody(B, { date: farDate, time: '19:30' }))
    expect(far.statusCode).toBe(400)
    const ef = far.json().error as { code: string; message: string }
    expect(tabletHelpers.policyRefusalText(ef.code, ef.message)).toMatch(/bookings open 60 days in advance/)
  })
})

// ─── SMTP password at rest ───────────────────────────────────────────────────

describe('SMTP password at rest (PUT/GET /auth/integrations/email, mailConfig, /health)', () => {
  const SMTP_SECRET = 'smtp-SECRET-pass-0123456789'
  const put = (who: Who, extra: Record<string, unknown> = {}) =>
    call(who, 'PUT', '/auth/integrations/email', { host: 'smtp.ops5.example', port: '587', user: 'mailer', from: 'noreply@ops5.example', ...extra })
  const rawPass = async () => (await prisma.setting.findUnique({ where: { key: SMTP_PASS_KEY } }))?.value ?? null

  beforeAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { in: [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY] } } })
    delete process.env['SMTP_PASS']
    invalidateMailConfig()
  })

  it('WITHOUT SERVD_SECRET_KEY: saving still works, in plain text, and the answer, GET and /health say so', async () => {
    delete process.env['SERVD_SECRET_KEY']
    expect(await smtpSecretHealth()).toMatchObject({ check: 'off' })

    const r = await put(ceoA, { pass: SMTP_SECRET })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, passAtRest: 'plaintext' })
    expect(r.json().warning).toMatch(/SERVD_SECRET_KEY/)
    expect(r.body).not.toContain(SMTP_SECRET)
    expect(await rawPass()).toBe(SMTP_SECRET)

    expect((await mailConfig()).pass).toBe(SMTP_SECRET)
    const g = await call(itA, 'GET', '/auth/integrations/email')
    expect(g.statusCode, g.body).toBe(200)
    expect(g.json()).toMatchObject({ passSet: true, passAtRest: 'plaintext', passSource: 'database', configured: true })
    expect(g.body).not.toContain(SMTP_SECRET)

    const h = await smtpSecretHealth()
    expect(h.check).toBe('warn')
    expect(h.detail).toMatch(/plain text because SERVD_SECRET_KEY is not set/)
    // The audit row says the password changed, never the password.
    const log = await prisma.auditLog.findFirst({ where: { action: 'integrations.email.update' }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(log)).not.toContain(SMTP_SECRET)
    expect(log?.after).toMatchObject({ passChanged: true, passAtRest: 'plaintext' })
  })

  it('WITH the key: the plain password is encrypted on first read, still sends, and /health is ok', async () => {
    process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    invalidateMailConfig()
    expect((await mailConfig()).pass).toBe(SMTP_SECRET)
    const raw = await rawPass()
    expect(raw!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(raw!)).toBe(SMTP_SECRET)
    expect(await smtpSecretHealth()).toEqual({ check: 'ok', detail: 'The SMTP password is encrypted at rest.' })
    expect(await smtpPassView()).toEqual({ passSet: true, passAtRest: 'encrypted', passSource: 'database' })
  })

  it('WITH the key: PUT stores a new password encrypted; GET never returns it or its ciphertext', async () => {
    const r = await put(ceoA, { pass: `${SMTP_SECRET}-v2` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, passAtRest: 'encrypted' })
    const raw = await rawPass()
    expect(raw!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(raw!)).toBe(`${SMTP_SECRET}-v2`)
    expect((await mailConfig()).pass).toBe(`${SMTP_SECRET}-v2`)
    const g = await call(ceoA, 'GET', '/auth/integrations/email')
    expect(g.json()).toMatchObject({ passSet: true, passAtRest: 'encrypted', host: 'smtp.ops5.example' })
    expect(g.body).not.toContain(SMTP_SECRET)
    expect(g.body).not.toContain(raw!)
  })

  it('a save without `pass` leaves the stored password alone', async () => {
    const before = await rawPass()
    const r = await put(ceoA, { host: 'smtp2.ops5.example' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    expect(await rawPass()).toBe(before)
    expect((await mailConfig()).host).toBe('smtp2.ops5.example')
  })

  it('encrypted but the key is gone: never sent as the password, falls back to SMTP_PASS, /health warns', async () => {
    delete process.env['SERVD_SECRET_KEY']
    invalidateMailConfig()
    expect((await mailConfig()).pass).toBe('')
    process.env['SMTP_PASS'] = 'env-fallback-pass'
    invalidateMailConfig()
    expect((await mailConfig()).pass).toBe('env-fallback-pass')
    const h = await smtpSecretHealth()
    expect(h.check).toBe('warn')
    expect(h.detail).toMatch(/encrypted but SERVD_SECRET_KEY is missing or wrong/)
    expect((await call(ceoA, 'GET', '/auth/integrations/email')).json()).toMatchObject({ passSet: true, passAtRest: 'unreadable', passSource: 'database' })
    // The stored ciphertext is untouched (restoring the key brings it back).
    expect((await rawPass())!.startsWith('enc:v1:')).toBe(true)
    delete process.env['SMTP_PASS']
  })

  it('clearing the password (pass: "") stores nothing; /health is off', async () => {
    process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    const r = await put(ceoA, { pass: '' })
    expect(r.json()).toEqual({ ok: true, passAtRest: 'none' })
    expect(await rawPass()).toBe('')
    expect(await smtpSecretHealth()).toMatchObject({ check: 'off' })
    expect(await smtpPassView()).toEqual({ passSet: false, passAtRest: 'none', passSource: 'unset' })
  })

  it('sealSmtpPass: encrypted with a key, as typed without one (never throws)', () => {
    process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    const s = sealSmtpPass(' p@ss ')
    expect(s.atRest).toBe('encrypted')
    expect(decryptSecret(s.value)).toBe('p@ss')
    delete process.env['SERVD_SECRET_KEY']
    expect(sealSmtpPass(' p@ss ')).toEqual({ value: 'p@ss', atRest: 'plaintext' })
    process.env['SERVD_SECRET_KEY'] = 'not-a-valid-key'
    expect(sealSmtpPass('p@ss')).toEqual({ value: 'p@ss', atRest: 'plaintext' })
    delete process.env['SERVD_SECRET_KEY']
  })

  it('only the CEO saves (IT gets 403); a floor host cannot read it', async () => {
    expect((await put(itA, { pass: 'x' })).statusCode).toBe(403)
    expect((await call(hostA, 'GET', '/auth/integrations/email')).statusCode).toBe(403)
  })
})

// ─── NEEDS 23 — the fiscal screens ──────────────────────────────────────────

describe('NEEDS 23 — fiscal screen texts and types', () => {
  it('connectorErrorText has plain words for REPORTING_OFF, NOT_LIVE, TOTALS_MISMATCH, FISCAL_IN_DOUBT', () => {
    expect(conn.connectorErrorText(new ApiError(409, 'REPORTING_OFF', 'x'))).toMatch(/switched off for this company.*held sales are kept.*back on/)
    expect(conn.connectorErrorText(new ApiError(409, 'NOT_LIVE', 'x'))).toMatch(/not live yet.*Go live/)
    const mm = conn.connectorErrorText(new ApiError(409, 'TOTALS_MISMATCH', 'The figures still do not add up: total 120000 is not the bill 126500'))
    expect(mm).toMatch(/not sent/)
    expect(mm).toMatch(/Problem: total 120000 is not the bill 126500/)
    expect(mm).toMatch(/Record manual filing/)
    expect(conn.connectorErrorText(new ApiError(409, 'FISCAL_IN_DOUBT', 'It may already be at the fiscal POS.'))).toMatch(/Do not file it on the authority portal/)
  })

  it('marks a totals-mismatch document, and its in-doubt variant, with what to do', () => {
    const plain = { status: 'failed' as const, statusReason: 'totals_mismatch', lastErrorCode: 'TOTALS_MISMATCH', lastError: 'total 1 is not the bill 2' }
    expect(conn.isTotalsMismatch(plain)).toBe(true)
    expect(conn.isMismatchInDoubt(plain)).toBe(false)
    expect(conn.mismatchAdvice(plain)?.steps).toMatch(/Check the order’s stored figures, then press Retry/)
    const doubt = { ...plain, lastErrorCode: 'UNKNOWN_TIMEOUT', lastError: 'TOTALS_MISMATCH (an earlier submit\'s outcome is unknown): x' }
    expect(conn.isMismatchInDoubt(doubt)).toBe(true)
    expect(conn.mismatchAdvice(doubt)?.steps).toMatch(/Do NOT file it by hand before they confirm/)
    // Other failures are not marked.
    expect(conn.mismatchAdvice({ status: 'failed', statusReason: null, lastErrorCode: 'HTTP_500', lastError: 'x' })).toBeNull()
    expect(conn.isTotalsMismatch({ status: 'pending', statusReason: 'totals_mismatch', lastErrorCode: null, lastError: null })).toBe(false)
    expect(conn.docReasonLabel('totals_mismatch')).toMatch(/do not add up/)
    expect(conn.docReasonLabel('not_registered')).toBe('Brand has no POS id')
    expect(conn.docReasonLabel('something_new')).toBe('something new')
    expect(conn.docReasonLabel(null)).toBeNull()
  })

  it('the real routes carry what the screens read: heldNote, heldCount, REPORTING_OFF — per company', async () => {
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
    const id = await mkOrder(B, { items: [{ menuItemId: B.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }], taxCents: 8_250, taxRatePct: 15, totalCents: 63_250 })
    await prisma.fiscalDocument.create({
      data: {
        tenantId: B.tenantId, kind: 'sale', orderId: id, conceptId: B.conceptId, idempotencyKey: `sale:${id}`,
        status: 'held', statusReason: 'no_connector', payload: { version: 1 }, payloadHash: 'h', amountCents: 63_250,
      },
    })
    const off = await call(ceoB, 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'test kitchen, not selling' })
    expect(off.statusCode, off.body).toBe(200)
    const res = off.json() as import('../../frontend/admin/src/lib/connectorsApi.ts').ReportingRequiredResult
    expect(res).toMatchObject({ fiscalReportingRequired: false, heldCount: 1 })
    expect(res.heldNote).toMatch(/1 sale was held before/)

    const ov = (await call(ceoB, 'GET', '/connectors')).json() as import('../../frontend/admin/src/lib/connectorsApi.ts').ConnectorsOverview
    expect(ov.heldNote).toMatch(/no sale is ever skipped/)
    // Company A never sees B's note.
    expect((await call(ceoA, 'GET', '/connectors')).json().heldNote).toBeNull()

    await setConnector(B.tenantId, 'fiscal', { driver: 'test', enabled: true })
    const rel = await call(ceoB, 'POST', '/connectors/fiscal/documents/release', {})
    expect(rel.statusCode).toBe(409)
    expect(conn.connectorErrorText(toApiError(rel))).toMatch(/switch "Fiscal reporting required" back on/)

    // Back on, but the fiscal POS off → NOT_LIVE, in plain words.
    await call(ceoB, 'PUT', '/connectors/fiscal/reporting-required', { required: true, reason: 'starts selling' })
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
    const rel2 = await call(ceoB, 'POST', '/connectors/fiscal/documents/release', {})
    expect(rel2.statusCode).toBe(409)
    expect(conn.connectorErrorText(toApiError(rel2))).toMatch(/not live yet/)
  })

  it('a totals-mismatch document in the Submissions list is recognised from the row the API returns (A only)', async () => {
    const id = await mkOrder(A, { items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }], taxCents: 8_250, taxRatePct: 15, totalCents: 60_000 })
    const doc = await prisma.fiscalDocument.create({
      data: {
        tenantId: A.tenantId, kind: 'sale', orderId: id, conceptId: A.conceptId, idempotencyKey: `sale:${id}`,
        status: 'failed', statusReason: 'totals_mismatch', lastErrorCode: 'TOTALS_MISMATCH', lastError: 'total 60000 is not the bill 63250',
        payload: { version: 1 }, payloadHash: 'h', amountCents: 60_000,
      },
    })
    const listA = (await call(ceoA, 'GET', '/connectors/fiscal/documents?status=failed')).json() as import('../../frontend/admin/src/lib/connectorsApi.ts').FiscalDocsPage
    const row = listA.items.find((r) => r.id === doc.id)
    expect(row).toBeDefined()
    expect(conn.isTotalsMismatch(row!)).toBe(true)
    expect(conn.mismatchAdvice(row!)?.title).toBe('Not sent: the figures do not add up')
    const detail = (await call(ceoA, 'GET', `/connectors/fiscal/documents/${doc.id}`)).json()
    expect(conn.isTotalsMismatch(detail)).toBe(true)
    // Company B cannot see it.
    expect((await call(ceoB, 'GET', `/connectors/fiscal/documents/${doc.id}`)).statusCode).toBe(404)
    const listB = (await call(ceoB, 'GET', '/connectors/fiscal/documents?status=failed')).json() as { items: Array<{ id: string }> }
    expect(listB.items.map((r) => r.id)).not.toContain(doc.id)
  })
})

// ─── O-RV-2 — what a totals-mismatch row tells the operator ─────────────────

describe('O-RV-2 — totals-mismatch advice by kind, and after a failed Retry (pure)', () => {
  const sale = { kind: 'sale' as const, status: 'failed' as const, statusReason: 'totals_mismatch', lastErrorCode: 'TOTALS_MISMATCH', lastError: 'lines 1 + tax 0 = 1, not the bill 2' }
  const refund = { ...sale, kind: 'refund' as const }
  const inDoubt = (k: 'sale' | 'refund') => ({ ...sale, kind: k, lastErrorCode: 'UNKNOWN_TIMEOUT', lastError: 'TOTALS_MISMATCH (an earlier submit\'s outcome is unknown): x' })
  const stillWrong = new ApiError(409, 'TOTALS_MISMATCH', 'The figures still do not add up: lines 1 + tax 0 = 1, not the bill 2')
  const inDoubtErr = new ApiError(409, 'FISCAL_IN_DOUBT', 'This sale may already be at the fiscal POS … this fiscal POS cannot be asked about a document.')

  it('a sale (not in doubt): check the order, Retry rebuilds it, then file by hand if it still fails', () => {
    const a = conn.mismatchAdvice(sale)!
    expect(a.steps).toMatch(/rebuilds the sale from the order/)
    expect(a.steps).toMatch(/Record manual filing/)
    // The Retry failure on a sale keeps the general words (fix the order or file by hand).
    expect(conn.retryErrorText(stillWrong, sale)).toBe(conn.connectorErrorText(stillWrong))
  })

  it('a refund (not in doubt): Retry only re-checks the stored figures — file it by hand, never "fix the order, then Retry"', () => {
    const a = conn.mismatchAdvice(refund)!
    expect(a.steps).toMatch(/not rebuilt from the order/)
    expect(a.steps).toMatch(/Retry only checks the same stored figures again/)
    expect(a.steps).toMatch(/Record manual filing/)
    expect(a.steps).not.toMatch(/rebuilds/)
    expect(a.steps).not.toMatch(/then press Retry/)
    const t = conn.retryErrorText(stillWrong, refund)
    expect(t).toMatch(/does not rebuild a refund/)
    expect(t).toMatch(/Record manual filing/)
    expect(t).not.toMatch(/Check the order/)
  })

  it('in doubt (sale or refund): ask the vendor outside servd; never "file it by hand" before they confirm — on the row AND after Retry', () => {
    for (const k of ['sale', 'refund'] as const) {
      const row = inDoubt(k)
      expect(conn.isMismatchInDoubt(row)).toBe(true)
      const a = conn.mismatchAdvice(row)!
      expect(a.steps).toMatch(new RegExp(`may already have filed this ${k}`))
      expect(a.steps).toMatch(/cannot ask this fiscal POS about it automatically, so Retry will not settle it/)
      expect(a.steps).toMatch(/Ask the fiscal POS vendor \(outside servd\)/)
      expect(a.steps).toMatch(/Do NOT file it by hand before they confirm/)
      expect(a.steps).not.toMatch(/Press Retry first/)
      // The sale's Retry answers FISCAL_IN_DOUBT; the refund's answers TOTALS_MISMATCH
      // (a refund is never looked up). Either way the in-doubt words, never the
      // general "file it on the authority portal and use Record manual filing".
      for (const err of [stillWrong, inDoubtErr]) {
        const t = conn.retryErrorText(err, row)
        expect(t).toMatch(/Do NOT file it by hand before they confirm/)
        expect(t).not.toBe(conn.connectorErrorText(err))
        expect(t).not.toMatch(/Check the order's stored figures/)
      }
    }
  })

  it('any other row or error falls back to connectorErrorText', () => {
    const other = { kind: 'sale' as const, status: 'failed' as const, statusReason: null, lastErrorCode: 'HTTP_500', lastError: 'x' }
    const http = new ApiError(502, 'UPSTREAM', 'The fiscal POS did not answer')
    expect(conn.retryErrorText(http, other)).toBe(conn.connectorErrorText(http))
    expect(conn.retryErrorText(stillWrong, other)).toBe(conn.connectorErrorText(stillWrong))
    expect(conn.retryErrorText(http, inDoubt('sale'))).toBe(conn.connectorErrorText(http))
    expect(conn.retryErrorText(stillWrong, undefined)).toBe(conn.connectorErrorText(stillWrong))
  })
})

describe('O-RV-2 — Retry on a mismatch row against the real route (two companies)', () => {
  // A refund payload whose lines + tax (57 500) are not its total (60 000).
  const badRefundPayload = (docId: string, orderId: string) => ({
    version: 1, documentId: docId, kind: 'refund', orderId, orderRef: orderId.slice(-8).toUpperCase(),
    lines: [{ name: 'Kheer', quantity: 1, taxableCents: 50_000, taxCents: 7_500 }],
    totals: { saleValueCents: 50_000, discountCents: 0, taxableCents: 50_000, taxCents: 7_500, taxRatePct: 15, serviceChargeCents: 0, tipCents: 0, totalCents: 60_000 },
  })
  const mkMismatch = async (co: Company, kind: 'sale' | 'refund', inDoubt: boolean) => {
    const orderId = await mkOrder(co, { items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 50_000 }], taxCents: 7_500, taxRatePct: 15, totalCents: 60_000 })
    const id = randomUUID()
    const doc = await prisma.fiscalDocument.create({
      data: {
        id, tenantId: co.tenantId, kind, orderId, conceptId: co.conceptId, idempotencyKey: `${kind}:${orderId}:${id}`,
        status: 'failed', statusReason: 'totals_mismatch',
        lastErrorCode: inDoubt ? 'UNKNOWN_TIMEOUT' : 'TOTALS_MISMATCH',
        lastError: `${inDoubt ? 'TOTALS_MISMATCH (an earlier submit\'s outcome is unknown): ' : ''}lines 50000 + tax 7500 = 57500, not the bill 60000`,
        payload: badRefundPayload(id, orderId), payloadHash: 'h', amountCents: 60_000,
      },
    })
    return doc.id
  }
  /** The row as the Submissions list returns it, and what the screen shows after its Retry fails. */
  const retryAsScreen = async (who: Who, docId: string) => {
    const list = (await call(who, 'GET', '/connectors/fiscal/documents?status=failed')).json() as import('../../frontend/admin/src/lib/connectorsApi.ts').FiscalDocsPage
    const row = list.items.find((r) => r.id === docId)
    expect(row).toBeDefined()
    const res = await call(who, 'POST', `/connectors/fiscal/documents/${docId}/retry`, {})
    return { row: row!, res, text: res.statusCode >= 400 ? conn.retryErrorText(toApiError(res), row) : null }
  }

  let spy: { mockRestore: () => void } | null = null
  beforeAll(async () => {
    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' } } })
    // This fiscal POS cannot be asked about a document (no lookup) — the only
    // way the outbox leaves a mismatch row in doubt.
    spy = vi.spyOn(testFiscalDriver, 'capabilities').mockReturnValue({ refunds: true, zeroValue: true, lookup: false })
  })
  afterAll(async () => {
    spy?.mockRestore()
    await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
  })

  it('a refund: Retry re-checks the frozen figures (409 TOTALS_MISMATCH) — the screen says file it by hand, not "fix the order"', async () => {
    const id = await mkMismatch(A, 'refund', false)
    const { row, res, text } = await retryAsScreen(ceoA, id)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('TOTALS_MISMATCH')
    expect(conn.mismatchAdvice(row)?.steps).toMatch(/Retry only checks the same stored figures again/)
    expect(text).toMatch(/does not rebuild a refund/)
    expect(text).toMatch(/Record manual filing/)
    // Company B can neither retry nor see it.
    expect((await call(ceoB, 'POST', `/connectors/fiscal/documents/${id}/retry`, {})).statusCode).toBe(404)
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id } })).status).toBe('failed')
  })

  it('an in-doubt sale on a fiscal POS without lookup: 409 FISCAL_IN_DOUBT — the screen never says to file it by hand first', async () => {
    const id = await mkMismatch(A, 'sale', true)
    const { row, res, text } = await retryAsScreen(ceoA, id)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('FISCAL_IN_DOUBT')
    expect(conn.isMismatchInDoubt(row)).toBe(true)
    expect(conn.mismatchAdvice(row)?.steps).toMatch(/Retry will not settle it/)
    expect(text).toMatch(/Ask the fiscal POS vendor \(outside servd\)/)
    expect(text).toMatch(/Do NOT file it by hand before they confirm/)
    // Nothing was rebuilt or resent.
    const after = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id } })
    expect(after).toMatchObject({ status: 'failed', lastErrorCode: 'UNKNOWN_TIMEOUT', amountCents: 60_000 })
    expect((await call(ceoB, 'POST', `/connectors/fiscal/documents/${id}/retry`, {})).statusCode).toBe(404)
  })

  it('an in-doubt refund: 409 TOTALS_MISMATCH (a refund is never looked up) — still the in-doubt words, not "file it by hand"', async () => {
    const id = await mkMismatch(A, 'refund', true)
    const { row, res, text } = await retryAsScreen(ceoA, id)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('TOTALS_MISMATCH')
    // What connectorErrorText alone would have said — the contradiction the fix removes.
    expect(conn.connectorErrorText(toApiError(res))).toMatch(/file it on the authority portal and use Record manual filing/)
    expect(text).toMatch(/may already have filed this refund/)
    expect(text).toMatch(/Do NOT file it by hand before they confirm/)
    expect(text).not.toMatch(/Check the order's stored figures/)
    expect(conn.mismatchAdvice(row)?.title).toMatch(/earlier send’s result is unknown/)
  })
})
