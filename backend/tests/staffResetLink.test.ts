// HR (and the CEO) send a person a password reset link (owner, 2026-10-16:
// "give hr a way to issue password reset links to employee emails").
// POST /auth/staff/:id/send-password-link reuses the "Forgot password" sender:
// the link goes to the person's OWN email / WhatsApp, one use, 30 minutes.
//
//   - Two companies: HR of B gets 404 on A's login; HR of A sends to A's login.
//   - HR never for the CEO's or a co-owner's login (403); the CEO may.
//   - Cashier / finance / management cannot use it (403).
//   - No email 422, not active 409, more than 3 an hour 429 (parallel too, and
//     counting the person's own Forgot-password links), no channel 503.
//   - A login shared with another company 403; a floor login 400; practice copy 503.
//   - The link is never returned to the caller; an audit row is written.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const sent: Array<{ to: string; body: string }> = []
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return {
    ...real,
    emailConfigured: vi.fn(async () => true),
  }
})
// The reset sender emails through lib/notify.js.
vi.mock('../src/lib/notify.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/notify.js')>()
  return { ...real, sendEmail: vi.fn(async (to: string, _subject: string, html: string) => { sent.push({ to, body: html }) }) }
})
vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, whatsappConfigured: vi.fn(async () => false), sendText: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const mailer = await import('../src/lib/mailer.js')

const stamp = Date.now()
const P = `rsl${stamp}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
type U = { id: string; name: string; email: string | null; role: string }
const U: Record<string, U> = {}

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`.toLowerCase() /* stored normalised, as the app does */, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email, role: u.role }
  return U[key]!
}
function auth(key: string) {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email ?? '', role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}
const send = (key: string, id: string) =>
  app.inject({ method: 'POST', url: `/api/v1/auth/staff/${id}/send-password-link`, headers: auth(key), payload: {} })
const links = (userId: string) => prisma.staffPasswordReset.count({ where: { userId } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Reset Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Reset Co B', slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoA2', 'admin', [T.A])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('mgmtA', 'management', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('staffA', 'marketing', [T.A])
  await mkUser('staffA2', 'marketing', [T.A])
  await mkUser('staffB', 'marketing', [T.B])
  await mkUser('pendingA', 'marketing', [T.A], { accountStatus: 'pending' })
  await mkUser('offA', 'marketing', [T.A], { accountStatus: 'suspended', isActive: false })
  await mkUser('noMailA', 'marketing', [T.A], { email: null })
  await mkUser('hrNoModule', 'hr', [T.A], { moduleDeny: ['staff_hr'] })
  await mkUser('staffA3', 'marketing', [T.A])
  await mkUser('staffA4', 'marketing', [T.A])
  await mkUser('sharedAB', 'marketing', [T.A, T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('HR sends a password reset link', () => {
  it("HR of company A sends one to A's login: emailed to the person, never returned, audited", async () => {
    sent.length = 0
    const r = await send('hrA', U['staffA']!.id)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ id: U['staffA']!.id, email: U['staffA']!.email, sentBy: { email: true, whatsapp: false } })
    expect(JSON.stringify(r.json())).not.toMatch(/reset-password\?token=/)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(U['staffA']!.email)
    expect(sent[0]!.body).toMatch(/reset-password\?token=/)
    expect(await links(U['staffA']!.id)).toBe(1)
    const a = await prisma.auditLog.findFirst({ where: { entityId: U['staffA']!.id, action: 'user.password_link_sent' } })
    expect(a?.userId).toBe(U['hrA']!.id)
    expect(a?.tenantId).toBe(T.A)
  })

  it("HR of company B gets 404 on company A's login and nothing is sent", async () => {
    sent.length = 0
    const r = await send('hrB', U['staffA2']!.id)
    expect(r.statusCode).toBe(404)
    expect(sent).toHaveLength(0)
    expect(await links(U['staffA2']!.id)).toBe(0)
    // ...and B's HR does reach B's own people.
    expect((await send('hrB', U['staffB']!.id)).statusCode).toBe(200)
  })

  it("HR never for the CEO's or a co-owner's login; the CEO may", async () => {
    const a = await send('hrA', U['ceoA']!.id)
    expect(a.statusCode).toBe(403)
    expect(a.json().error.code).toBe('RESET_LINK_CEO_ONLY')
    const o = await send('hrA', U['ownerA']!.id)
    expect(o.statusCode).toBe(403)
    expect(o.json().error.code).toBe('RESET_LINK_CEO_ONLY')
    expect((await send('ceoA', U['ownerA']!.id)).statusCode).toBe(200)
    expect((await send('ceoA', U['ceoA2']!.id)).statusCode).toBe(200)
  })

  it('other roles cannot send one, and HR without the HR module cannot either', async () => {
    for (const k of ['cashA', 'finA', 'mgmtA', 'ownerA']) {
      expect((await send(k, U['staffA2']!.id)).statusCode).toBe(403)
    }
    expect((await send('hrNoModule', U['staffA2']!.id)).statusCode).toBe(403)
    expect(await links(U['staffA2']!.id)).toBe(0)
  })

  it('no email 422, waiting / switched-off login 409', async () => {
    expect((await send('hrA', U['noMailA']!.id)).json().error.code).toBe('EMAIL_REQUIRED')
    expect((await send('hrA', U['pendingA']!.id)).statusCode).toBe(409)
    expect((await send('hrA', U['offA']!.id)).statusCode).toBe(409)
  })

  it('at most 3 links per person an hour (429); each new link kills the older one', async () => {
    const id = U['staffA2']!.id
    for (let i = 0; i < 3; i++) expect((await send('hrA', id)).statusCode).toBe(200)
    const r = await send('hrA', id)
    expect(r.statusCode).toBe(429)
    expect(r.json().error.code).toBe('TOO_MANY_LINKS')
    expect(await prisma.staffPasswordReset.count({ where: { userId: id, consumedAt: null } })).toBe(1)
  })

  it('parallel clicks cannot get past the cap (atomic bucket)', async () => {
    const id = U['staffA3']!.id
    const rs = await Promise.all(Array.from({ length: 6 }, () => send('hrA', id)))
    const ok = rs.filter((r) => r.statusCode === 200).length
    expect(ok).toBeGreaterThan(0)
    expect(ok).toBeLessThanOrEqual(3)
    expect(rs.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 429)).toBe(true)
    expect(await links(id)).toBeLessThanOrEqual(3)
  })

  it("the person's own Forgot-password links count towards the cap", async () => {
    const id = U['staffA4']!.id
    for (let i = 0; i < 3; i++) {
      await prisma.staffPasswordReset.create({ data: { userId: id, tokenHash: `${P}-self-${i}`, expiresAt: new Date(Date.now() + 60_000) } })
    }
    const r = await send('hrA', id)
    expect(r.statusCode).toBe(429)
    expect(r.json().error.code).toBe('TOO_MANY_LINKS')
  })

  it('a login shared with a company the sender is not in is refused (403), nothing sent', async () => {
    sent.length = 0
    const r = await send('hrA', U['sharedAB']!.id)
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('LOGIN_IN_OTHER_COMPANY')
    expect(sent).toHaveLength(0)
    expect(await links(U['sharedAB']!.id)).toBe(0)
  })

  it('floor logins sign in with a code: no reset link (400)', async () => {
    const r = await send('hrA', U['cashA']!.id)
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('NOT_A_PASSWORD_LOGIN')
    expect(await links(U['cashA']!.id)).toBe(0)
  })

  it('the practice copy sends no links (503), nothing issued', async () => {
    const prev = process.env['SERVD_SANDBOX']
    process.env['SERVD_SANDBOX'] = '1'
    try {
      const r = await send('ceoA', U['finA']!.id)
      expect(r.statusCode).toBe(503)
      expect(r.json().error.code).toBe('PRACTICE_NO_LINKS')
    } finally {
      if (prev === undefined) delete process.env['SERVD_SANDBOX']
      else process.env['SERVD_SANDBOX'] = prev
    }
    expect(await links(U['finA']!.id)).toBe(0)
  })

  it('503 when neither email nor WhatsApp is set up', async () => {
    vi.mocked(mailer.emailConfigured).mockResolvedValueOnce(false)
    const r = await send('ceoA', U['mgmtA']!.id)
    expect(r.statusCode).toBe(503)
    expect(r.json().error.code).toBe('RESET_DELIVERY_UNAVAILABLE')
  })
})

// Owner, 2026-10-16: "Give this option to HR also" — Reissue password
// (POST /auth/users/:id/reissue-password) for HR, same limits as the link.
describe('HR issues a new password', () => {
  const reissue = (key: string, id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/auth/users/${id}/reissue-password`, headers: auth(key), payload: {} })

  it("HR of A issues one for A's login: shown once, the person must change it, audited with HR as actor", async () => {
    const r = await reissue('hrA', U['staffA3']!.id)
    expect(r.statusCode, r.body).toBe(200)
    const pw = r.json().temporaryPassword as string
    expect(pw.length).toBeGreaterThanOrEqual(12)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: U['staffA3']!.id }, select: { password: true, mustChangePassword: true } })
    expect(await bcrypt.compare(pw, row.password)).toBe(true)
    expect(row.mustChangePassword).toBe(true)
    const a = await prisma.auditLog.findFirst({ where: { entityId: U['staffA3']!.id, action: 'user.password_reissue' } })
    expect(a?.userId).toBe(U['hrA']!.id)
    expect(JSON.stringify(a)).not.toContain(pw)
  })

  it("HR of B gets 404 on A's login; a login shared with B is refused for A's HR", async () => {
    expect((await reissue('hrB', U['staffA4']!.id)).statusCode).toBe(404)
    expect((await reissue('hrA', U['sharedAB']!.id)).statusCode).toBe(403)
  })

  it("HR never for the CEO's, a co-owner's, its own or a floor login; the CEO may for a co-owner", async () => {
    expect((await reissue('hrA', U['ceoA']!.id)).json().error.code).toBe('REISSUE_CEO_ONLY')
    expect((await reissue('hrA', U['ownerA']!.id)).json().error.code).toBe('REISSUE_CEO_ONLY')
    expect((await reissue('hrA', U['hrA']!.id)).json().error.code).toBe('REISSUE_SELF')
    expect((await reissue('hrA', U['cashA']!.id)).json().error.code).toBe('NOT_A_PASSWORD_LOGIN')
    expect((await reissue('ceoA', U['ownerA']!.id)).statusCode).toBe(200)
  })

  it('other roles and HR without the HR module are refused', async () => {
    for (const k of ['finA', 'mgmtA', 'cashA', 'ownerA', 'hrNoModule']) {
      expect((await reissue(k, U['staffA4']!.id)).statusCode, k).toBe(403)
    }
  })
})
