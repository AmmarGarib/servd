// Auth review findings on the 2026-10-10 fixes (AUTH-R1…R7) and the fix
// agents' follow-ups (F3, F4):
//
//   R1  a login tied to its company only by users.tenantId (no member row —
//       the state the boot backfill leaves) keeps that company: switching away
//       records it as a membership, switching into one's own primary works, and
//       the backfill migration makes the primary a real membership. The CEO
//       can still approve that company's hires and edit his own companies.
//   R2  a manager-issued sign-in code still redeems after the cashier used up
//       the per-phone bucket tapping "Send code".
//   R3  the PIN-change and change-authed limits are claimed atomically —
//       a parallel burst gets no more tries than the stated cap.
//   R4  every self-service PIN attempt is counted, a PIN_COLLISION included
//       (and audited), so colleagues' PINs cannot be enumerated.
//   R5  two creates of the same floor number at once: exactly one wins.
//   R6  "suspend + make cashier + clear phone, then switch back on" is refused.
//   R7  / F4  legacy duplicate or missing phones block only NEW conflicts:
//       office-role changes, name edits, re-saving the same number and
//       approving one of two pending invites all go through.
//
// Real route handlers (and the real auth middleware) through Fastify inject,
// against the disposable test DB and Redis.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined), whatsappConfigured: vi.fn(async () => false) }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined), emailConfigured: vi.fn(async () => false) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { tenantRoutes } = await import('../src/modules/tenants/routes.js')
const { issueStaffSession, findOtpLoginStaff } = await import('../src/modules/auth/service.js')
const { normalisePhone } = await import('../src/modules/auth/otp.js')
const { recordFailure, STAFF_OTP_PHONE_LIMIT } = await import('../src/lib/loginRateLimit.js')
const { AppError } = await import('../src/lib/errors.js')

const PREFIX = 'aar'
const STAMP = Date.now()
const PASSWORD = 'Correct-Horse-Battery-77'
const CEO_EMAIL = 'ammar.garib@gsfoods.pk'
let app: FastifyInstance
let tenantA: string   // "GS Foods"
let tenantB: string   // "GSX Viva"
let tenantGone: string
const created: string[] = []

let phoneSeq = 0
function uniquePhone(): string {
  const n = ((STAMP % 900_000_000) + 200_000_000 + phoneSeq++ * 7919) % 1_000_000_000
  return `03${String(n).padStart(9, '0')}`
}
let emailSeq = 0
const uniqueEmail = (tag: string) => `${PREFIX}.${tag}.${STAMP}.${emailSeq++}@gsfoods.pk`

async function makeUser(opts: {
  role: string; tenantId: string | null; members?: string[]; phone?: string | null; email?: string
  accountStatus?: 'pending' | 'active' | 'suspended'; isActive?: boolean; pin?: string
}) {
  // NOTE: `members` is the exact TenantMember set — the primary is NOT added
  // automatically, so a "users.tenantId only" login can be built.
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${opts.role} ${created.length + 1}`,
      email: opts.email ?? uniqueEmail(opts.role),
      password: await bcrypt.hash(PASSWORD, 4),
      role: opts.role as never,
      tenantId: opts.tenantId,
      phone: opts.phone ?? null,
      accountStatus: opts.accountStatus ?? 'active',
      isActive: opts.isActive ?? true,
      pin: opts.pin ? await bcrypt.hash(opts.pin, 4) : null,
      ...(opts.members?.length ? { tenantMemberships: { create: opts.members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) } } : {}),
    },
    select: { id: true, name: true, email: true, role: true },
  })
  created.push(u.id)
  return u
}

type U = { id: string; name: string | null; email: string | null; role: string }
function auth(u: U, extra: Record<string, string> = {}) {
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}`, ...extra }
}
const call = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/v1${url}`, headers: auth(u, headers), ...(payload ? { payload } : {}) })
const ids = (r: { json: () => unknown }) => (r.json() as Array<{ id: string }>).map((x) => x.id)

async function runBackfillMigration() {
  const here = dirname(fileURLToPath(import.meta.url))
  const sql = readFileSync(join(here, '../prisma/migrations/20261010200000_auth_membership_backfill/migration.sql'), 'utf8')
  const statements = sql
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((x) => x.trim()).filter(Boolean)
  expect(statements.length).toBe(2)
  for (const st of statements) await prisma.$executeRawUnsafe(st)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'AAR GS Foods', slug: `${PREFIX}-a-${STAMP}` }, select: { id: true } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'AAR GSX Viva', slug: `${PREFIX}-b-${STAMP}` }, select: { id: true } })).id
  tenantGone = (await prisma.tenant.create({ data: { name: 'AAR Closed', slug: `${PREFIX}-gone-${STAMP}`, deletedAt: new Date() }, select: { id: true } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(tenantRoutes, { prefix: '/api/v1/tenants' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  const extra = await prisma.user.findMany({ where: { email: { startsWith: `${PREFIX}.` } }, select: { id: true } })
  const all = Array.from(new Set([...created, ...extra.map((u) => u.id)]))
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: all } }, { userId: { in: all } }] } })
  await prisma.staffPasswordReset.deleteMany({ where: { userId: { in: all } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: all } } })
  await prisma.user.deleteMany({ where: { id: { in: all } } })
  await prisma.tenantMember.deleteMany({ where: { tenantId: { in: [tenantA, tenantB, tenantGone] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB, tenantGone] } } })
})

// ─── R1 / F3 ─────────────────────────────────────────────────────────────────

describe('AUTH-R1: a company tied only by users.tenantId is never lost', () => {
  it('the CEO with GS Foods as primary (no member row) and a Viva membership keeps both across switches, can approve and edit himself', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantB] })
    const pendingA = await makeUser({ role: 'finance', tenantId: tenantA, members: [tenantA], accountStatus: 'pending' })

    const mine0 = await call(ceo, 'GET', '/tenants/mine')
    expect(ids(mine0).sort()).toEqual([tenantA, tenantB].sort())

    expect((await call(ceo, 'POST', `/tenants/switch/${tenantB}`)).statusCode).toBe(200)
    // GS Foods was written down as a membership on the way out.
    expect(await prisma.tenantMember.count({ where: { userId: ceo.id, tenantId: tenantA } })).toBe(1)
    const mine1 = await call(ceo, 'GET', '/tenants/mine')
    expect(ids(mine1).sort()).toEqual([tenantA, tenantB].sort())
    expect((mine1.json() as Array<{ id: string; isActive: boolean }>).find((t) => t.id === tenantB)!.isActive).toBe(true)

    // Approving a GS Foods hire and editing his own companies still work.
    expect((await call(ceo, 'PATCH', `/auth/staff/${pendingA.id}/approve`)).statusCode).toBe(200)
    expect((await call(ceo, 'PATCH', `/auth/users/${ceo.id}`, { tenantIds: [tenantB, tenantA] })).statusCode).toBe(200)

    // And back.
    expect((await call(ceo, 'POST', `/tenants/switch/${tenantA}`)).statusCode).toBe(200)
    expect(ids(await call(ceo, 'GET', '/tenants/mine')).sort()).toEqual([tenantA, tenantB].sort())
  })

  it('F3: an admin with only users.tenantId sees and manages their company, and may "switch" into it', async () => {
    const admin = await makeUser({ role: 'admin', tenantId: tenantA })
    const staffA = await makeUser({ role: 'finance', tenantId: tenantA })
    expect(await prisma.tenantMember.count({ where: { userId: admin.id } })).toBe(0)

    expect(ids(await call(admin, 'GET', '/tenants/mine'))).toEqual([tenantA])
    expect(ids(await call(admin, 'GET', '/auth/users'))).toContain(staffA.id)
    expect((await call(admin, 'PATCH', `/auth/users/${staffA.id}`, { name: 'Renamed' })).statusCode).toBe(200)

    const sw = await call(admin, 'POST', `/tenants/switch/${tenantA}`)
    expect(sw.statusCode).toBe(200)
    expect(await prisma.tenantMember.count({ where: { userId: admin.id, tenantId: tenantA } })).toBe(1)
    expect(ids(await call(admin, 'GET', '/tenants/mine'))).toEqual([tenantA])
  })

  it('two-company: a company the caller does not belong to is still refused, and records nothing', async () => {
    const ceoB = await makeUser({ role: 'admin', tenantId: tenantB })
    const r = await call(ceoB, 'POST', `/tenants/switch/${tenantA}`)
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('NOT_A_MEMBER')
    expect(await prisma.tenantMember.count({ where: { userId: ceoB.id } })).toBe(0)
    expect(ids(await call(ceoB, 'GET', '/tenants/mine'))).toEqual([tenantB])
    // A moved login's new primary is a real membership too.
    const owner = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA, tenantB] })
    const mover = await makeUser({ role: 'finance', tenantId: tenantA, members: [tenantA] })
    expect((await call(owner, 'PATCH', `/auth/users/${mover.id}`, { tenantId: tenantB })).statusCode).toBe(200)
    expect(await prisma.tenantMember.count({ where: { userId: mover.id, tenantId: tenantB } })).toBe(1)
  })

  it('the backfill migration makes every live primary a membership, enrols only the GS Foods CEO everywhere, and is idempotent', async () => {
    const primaryOnly = await makeUser({ role: 'finance', tenantId: tenantA })
    const adminB = await makeUser({ role: 'admin', tenantId: tenantB })
    const onGone = await makeUser({ role: 'finance', tenantId: tenantGone })
    const existingCeo = await prisma.user.findUnique({ where: { email: CEO_EMAIL }, select: { id: true } })
    const ceo = existingCeo ? null : await makeUser({ role: 'admin', tenantId: tenantA, email: CEO_EMAIL })

    await runBackfillMigration()
    await runBackfillMigration()

    const rows = async (userId: string) => (await prisma.tenantMember.findMany({ where: { userId }, select: { tenantId: true } })).map((m) => m.tenantId).sort()
    expect(await rows(primaryOnly.id)).toEqual([tenantA])
    // Another company's CEO is NOT widened — only their own primary.
    expect(await rows(adminB.id)).toEqual([tenantB])
    // A deleted company is not backfilled.
    expect(await rows(onGone.id)).toEqual([])
    if (ceo) {
      const ceoRows = await rows(ceo.id)
      expect(ceoRows).toEqual(expect.arrayContaining([tenantA, tenantB]))
      expect(ceoRows).not.toContain(tenantGone)
      expect(ids(await call(ceo, 'GET', '/tenants/mine'))).toEqual(expect.arrayContaining([tenantA, tenantB]))
    }
  })
})

// ─── R2 ──────────────────────────────────────────────────────────────────────

// Retired 2026-10-28 (owner: email + password for every staff login, no WhatsApp codes): the floor phone-number
// and manager sign-in-code rules this file used to test are gone; staffOtpLogin.test.ts defends the retirement.
describe('AUTH-R3: parallel guesses do not get past the caps', () => {
  it('/pin/change: a burst of 20 wrong current PINs gets at most 5 checked', async () => {
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantA, members: [tenantA], pin: '4826' })
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      call(mgr, 'POST', '/auth/pin/change', { currentPin: String(5000 + i * 37), newPin: '614852' })))
    const checked = burst.filter((r) => r.statusCode === 400).length
    expect(checked).toBeLessThanOrEqual(5)
    expect(burst.filter((r) => r.statusCode === 429).length).toBe(20 - checked)
    // Even the right PIN now waits.
    expect((await call(mgr, 'POST', '/auth/pin/change', { currentPin: '4826', newPin: '614852' })).statusCode).toBe(429)
  })

  it('/password/change-authed: a burst of 20 wrong passwords gets at most 8 checked', async () => {
    const fin = await makeUser({ role: 'finance', tenantId: tenantA, members: [tenantA] })
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      call(fin, 'POST', '/auth/password/change-authed', { currentPassword: `wrong-${i}`, newPassword: 'A-Brand-New-Password-42' })))
    const checked = burst.filter((r) => r.statusCode === 400).length
    expect(checked).toBeLessThanOrEqual(8)
    expect(burst.filter((r) => r.statusCode === 429).length).toBe(20 - checked)
  })
})

// ─── R4 ──────────────────────────────────────────────────────────────────────

describe('AUTH-R4: the PIN-collision answer cannot be used to sweep colleagues\' PINs', () => {
  it('a collision is refused, audited and counted; every attempt counts toward a small hourly cap', async () => {
    await makeUser({ role: 'admin', tenantId: tenantB, members: [tenantB], pin: '739261' })   // the CEO's PIN
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantB, members: [tenantB] })

    const hit = await call(mgr, 'POST', '/auth/pin/change', { password: PASSWORD, newPin: '739261' })
    expect(hit.statusCode).toBe(409)
    expect(hit.json().error.code).toBe('PIN_COLLISION')
    expect(await prisma.auditLog.count({ where: { entityId: mgr.id, action: 'user.pin_collision', tenantId: tenantB } })).toBe(1)

    // Successful changes count too: 1 collision + 5 changes = 6, then refused.
    let current: string | null = null
    for (const next of ['825371', '937462', '351784', '648193', '572846']) {
      const r = await call(mgr, 'POST', '/auth/pin/change', current ? { currentPin: current, newPin: next } : { password: PASSWORD, newPin: next })
      expect(r.statusCode).toBe(200)
      current = next
    }
    const capped = await call(mgr, 'POST', '/auth/pin/change', { currentPin: current, newPin: '739518' })
    expect(capped.statusCode).toBe(429)
  })

  it('a malformed or guessable new PIN does not spend an attempt', async () => {
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantB, members: [tenantB] })
    for (let i = 0; i < 8; i++) {
      expect((await call(mgr, 'POST', '/auth/pin/change', { password: PASSWORD, newPin: '123456' })).json().error.code).toBe('WEAK_PIN')
    }
    expect((await call(mgr, 'POST', '/auth/pin/change', { password: PASSWORD, newPin: '486257' })).statusCode).toBe(200)
  })
})

// ─── R5 ──────────────────────────────────────────────────────────────────────
