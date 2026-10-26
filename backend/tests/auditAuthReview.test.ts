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

describe('AUTH-R2: a manager code works after the cashier exhausted "Send code"', () => {
  it('clears the per-phone bucket when the code is issued; the code redeems once', async () => {
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantA, members: [tenantA] })
    const phone = uniquePhone()
    const n = normalisePhone(phone)
    const cashier = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: n })
    for (let i = 0; i < STAFF_OTP_PHONE_LIMIT.max; i++) await recordFailure(STAFF_OTP_PHONE_LIMIT, `phone:${n}`)
    const verify = (c: string) => app.inject({ method: 'POST', url: '/api/v1/auth/staff/otp/verify', payload: { phone, code: c } })
    expect((await verify('000000')).statusCode).toBe(429)

    const r = await call(mgr, 'POST', `/auth/staff/${cashier.id}/sign-in-code`, {})
    expect(r.statusCode).toBe(201)
    const ok = await verify(r.json().code)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().user.id).toBe(cashier.id)
  })
})

// ─── R3 ──────────────────────────────────────────────────────────────────────

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

describe('AUTH-R5: one floor number, even when two saves race', () => {
  it('two simultaneous creates of the same cook (number written two ways): one 201, one 409', async () => {
    const owner = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA, tenantB] })
    const ceoA2 = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    for (let round = 0; round < 3; round++) {
      const phone = uniquePhone()
      const [x, y] = await Promise.all([
        call(owner, 'POST', '/auth/users', { name: 'Cook', email: uniqueEmail('race'), role: 'kitchen', phone }),
        call(ceoA2, 'POST', '/auth/users', { name: 'Cook', email: uniqueEmail('race'), role: 'kitchen', phone: `+92${phone.slice(1)}` }),
      ])
      expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409])
      expect(await findOtpLoginStaff(phone)).not.toBeNull()
    }
  })

  it('a simultaneous invite and create of the same cashier: one wins', async () => {
    const owner = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const foh = await makeUser({ role: 'foh_management', tenantId: tenantA, members: [tenantA] })
    const phone = uniquePhone()
    const [x, y] = await Promise.all([
      call(owner, 'POST', '/auth/users', { name: 'Till', email: uniqueEmail('race'), role: 'cashier', phone }),
      call(foh, 'POST', '/auth/staff/invite', { name: 'Till', email: uniqueEmail('race'), role: 'cashier', phone }),
    ])
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409])
  })
})

// ─── R6 ──────────────────────────────────────────────────────────────────────

describe('AUTH-R6: PHONE_REQUIRED holds while a login is suspended', () => {
  it('suspend + make cashier (+ clear phone) is refused; a plain reactivation of a legacy phoneless cashier is not', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantA, members: [tenantA], phone: normalisePhone(uniquePhone()) })
    const a = await call(ceo, 'PATCH', `/auth/users/${mgr.id}`, { isActive: false, role: 'cashier', phone: '' })
    expect(a.statusCode).toBe(400)
    expect(a.json().error.code).toBe('PHONE_REQUIRED')

    const noPhoneMgr = await makeUser({ role: 'foh_management', tenantId: tenantA, members: [tenantA] })
    const b = await call(ceo, 'PATCH', `/auth/users/${noPhoneMgr.id}`, { isActive: false, role: 'cashier' })
    expect(b.json().error.code).toBe('PHONE_REQUIRED')

    const suspendedCashier = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: normalisePhone(uniquePhone()), accountStatus: 'suspended', isActive: false })
    expect((await call(ceo, 'PATCH', `/auth/users/${suspendedCashier.id}`, { phone: '' })).json().error.code).toBe('PHONE_REQUIRED')

    const legacy = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], accountStatus: 'suspended', isActive: false })
    expect((await call(ceo, 'PATCH', `/auth/users/${legacy.id}`, { isActive: true })).statusCode).toBe(200)
  })
})

// ─── R7 / F4 ─────────────────────────────────────────────────────────────────

describe('AUTH-R7 / F4: legacy shared or missing phones block only new conflicts', () => {
  it('a manager sharing a number with an old cashier login can still be promoted; the cashier can still be renamed and re-saved', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const n = normalisePhone(uniquePhone())
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantA, members: [tenantA], phone: n })
    const oldTill = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: `0${n.slice(2)}` })

    expect((await call(ceo, 'PATCH', `/auth/users/${mgr.id}`, { role: 'management' })).statusCode).toBe(200)
    expect((await call(ceo, 'PATCH', `/auth/users/${oldTill.id}`, { name: 'Old till login' })).statusCode).toBe(200)
    // Re-saving the same number (any spelling) is not a change.
    expect((await call(ceo, 'PATCH', `/auth/users/${oldTill.id}`, { phone: `+${n}` })).statusCode).toBe(200)
    // The cashier still signs in by code — the office login never collided.
    expect((await findOtpLoginStaff(n))?.id).toBe(oldTill.id)
    // Moving the office login INTO a floor role on that number is a new conflict.
    const back = await call(ceo, 'PATCH', `/auth/users/${mgr.id}`, { role: 'foh' })
    expect(back.statusCode).toBe(409)
    expect(back.json().error.code).toBe('PHONE_IN_USE')
  })

  it('an office login may be created on a number a cashier holds; a second floor login may not (two-company)', async () => {
    const owner = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA, tenantB] })
    const phone = uniquePhone()
    await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: normalisePhone(phone) })
    const office = await call(owner, 'POST', '/auth/users', { name: 'Same person, office', email: uniqueEmail('office'), role: 'finance', phone, tenantId: tenantB })
    expect(office.statusCode).toBe(201)
    const floor = await call(owner, 'POST', '/auth/users', { name: 'Second till login', email: uniqueEmail('floor'), role: 'foh', phone, tenantId: tenantB })
    expect(floor.statusCode).toBe(409)
  })

  it('two pending invites of one person: the first approves, the second is then refused', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const n = normalisePhone(uniquePhone())
    const p1 = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: n, accountStatus: 'pending' })
    const p2 = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: n, accountStatus: 'pending' })
    expect((await call(ceo, 'PATCH', `/auth/staff/${p1.id}/approve`)).statusCode).toBe(200)
    const second = await call(ceo, 'PATCH', `/auth/staff/${p2.id}/approve`)
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('PHONE_IN_USE')
  })

  it('two active cashiers already sharing a number: edits still save, and suspending one restores code sign-in for the other', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const n = normalisePhone(uniquePhone())
    const c1 = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: n })
    const c2 = await makeUser({ role: 'foh', tenantId: tenantA, members: [tenantA], phone: n })
    expect(await findOtpLoginStaff(n)).toBeNull()
    expect((await call(ceo, 'PATCH', `/auth/users/${c1.id}`, { name: 'Renamed' })).statusCode).toBe(200)
    // Floor-to-floor role change on a legacy duplicate is not a new conflict.
    expect((await call(ceo, 'PATCH', `/auth/users/${c1.id}`, { role: 'foh' })).statusCode).toBe(200)
    expect((await call(ceo, 'PATCH', `/auth/users/${c2.id}`, { isActive: false })).statusCode).toBe(200)
    expect((await findOtpLoginStaff(n))?.id).toBe(c1.id)
    // …and the suspended one cannot come back as a duplicate.
    expect((await call(ceo, 'PATCH', `/auth/users/${c2.id}`, { isActive: true })).json().error.code).toBe('PHONE_IN_USE')
  })

  it('a legacy floor login whose stored number fails today\'s format check stays editable; a NEW bad number is refused', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const legacy = await makeUser({ role: 'cashier', tenantId: tenantA, members: [tenantA], phone: '3001234' })
    // The edit form re-sends the number on file unchanged — not a change.
    const same = await call(ceo, 'PATCH', `/auth/users/${legacy.id}`, { name: 'Legacy till', phone: '3001234' })
    expect(same.statusCode).toBe(200)
    expect((await prisma.user.findUnique({ where: { id: legacy.id }, select: { phone: true, name: true } }))).toEqual({ phone: '3001234', name: 'Legacy till' })
    const bad = await call(ceo, 'PATCH', `/auth/users/${legacy.id}`, { phone: '1234567' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('INVALID_PHONE')
    // Fixing it to a real number is accepted and stored normalised.
    const good = uniquePhone()
    expect((await call(ceo, 'PATCH', `/auth/users/${legacy.id}`, { phone: good })).statusCode).toBe(200)
    expect((await prisma.user.findUnique({ where: { id: legacy.id }, select: { phone: true } }))!.phone).toBe(normalisePhone(good))
  })

  it('two-company: company B\'s CEO cannot edit company A\'s legacy login, even re-sending its own number', async () => {
    const ceoB = await makeUser({ role: 'admin', tenantId: tenantB, members: [tenantB] })
    const legacyA = await makeUser({ role: 'kitchen', tenantId: tenantA, members: [tenantA] })
    expect((await call(ceoB, 'PATCH', `/auth/users/${legacyA.id}`, { name: 'Hijack' })).statusCode).toBe(404)
  })

  it('a legacy floor login with no phone can still be renamed and moved between floor roles', async () => {
    const ceo = await makeUser({ role: 'admin', tenantId: tenantA, members: [tenantA] })
    const legacy = await makeUser({ role: 'kitchen', tenantId: tenantA, members: [tenantA] })
    expect((await call(ceo, 'PATCH', `/auth/users/${legacy.id}`, { name: 'Legacy cook' })).statusCode).toBe(200)
    expect((await call(ceo, 'PATCH', `/auth/users/${legacy.id}`, { role: 'boh' })).statusCode).toBe(200)
  })
})
