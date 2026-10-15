// One company under two head offices (D1 spec §0 / §12): C is served by H1 at
// 40% and by H2 at 25% (H2 also serves D at 50%).
//
//   • C has two Due-to accounts and two "Head office charges" accounts;
//   • each run touches only its own pair, and each pair agrees across books;
//   • C cannot close a month until BOTH head offices have recharged it — the
//     check names the one still missing;
//   • ending H2's link with C leaves H1 untouched, and a later H2 month does not
//     charge C.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'
import { pairBalances } from '../src/modules/intercompany/accounts.js'
import { createHeadOffice, endLink, linkCompany } from '../src/modules/headOffices/service.js'
import { createSplitVersion } from '../src/modules/headOffices/splits.js'
import { confirmBooks, setRecharge } from '../src/modules/headOffices/books.js'
import { headOfficeCloseChecks } from '../src/modules/headOffices/closeChecks.js'
import { rechargeRunRoutes } from '../src/modules/headOffices/runRoutes.js'

const P = `ho2-${Date.now()}`
const BASE = '/accounting/intercompany/recharge-runs'
let app: FastifyInstance
let H1: string, H2: string, C: string, D: string
const users: Record<string, { id: string; token: string }> = {}
const charges = headOfficeCloseChecks.find((c) => c.key === 'head_office_charges')!

async function tenant(name: string) {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}` } })).id
}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method, url: `/api/v1${BASE}${url}`,
    headers: { authorization: `Bearer ${users.ceo!.token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}

async function cost(tenantId: string, date: string, cents: number) {
  await postJournalEntry({
    tenantId, sourceType: 'test.cost', sourceId: randomUUID(), description: 'test cost',
    entryDate: new Date(`${date}T12:00:00+05:00`), postedBy: 'system',
    lines: [{ accountCode: '6010', type: 'debit', amountCents: cents }, { accountCode: '1010', type: 'credit', amountCents: cents }],
  })
}

const ctx = (tenantId: string, through: string, months: string[]): CloseCheckContext =>
  ({ db: prisma, tenantId, prevLock: null, newLock: parsePktEndOfDay(through), months, isYearEnd: false })

/** Prepare, submit and approve (CEO) one month of a head office. */
async function recharge(hoId: string, period: string) {
  const p = await call('POST', '/', { headOfficeId: hoId, period })
  expect(p.statusCode).toBe(201)
  const id = p.json().id as string
  expect((await call('POST', `/${id}/submit`)).statusCode).toBe(200)
  const a = await call('POST', `/${id}/approve`, { acknowledgeWarnings: true })
  expect(a.statusCode).toBe(200)
  return a.json()
}

beforeAll(async () => {
  C = await tenant('Company C')
  D = await tenant('Company D')
  for (const t of [C, D]) await prisma.account.createMany({ data: [{ tenantId: t, code: '1010', name: 'Cash on Hand', type: 'asset' }] })
  await mkUser('ceo', 'admin', C, [C, D])
  const ceo = users.ceo!.id
  H1 = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'Head Office One', actorId: ceo }), { timeout: 30_000 })).id
  H2 = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'Head Office Two', actorId: ceo }), { timeout: 30_000 })).id
  await prisma.$transaction(async (t) => {
    await linkCompany(t, { hoId: H1, companyId: C, actorId: ceo })
    await linkCompany(t, { hoId: H2, companyId: C, actorId: ceo })
    await linkCompany(t, { hoId: H2, companyId: D, actorId: ceo })
    await createSplitVersion(t, { hoId: H1, effectiveFrom: '2026-08', lines: [{ companyTenantId: C, shareBps: 4000 }], actorId: ceo })
    await createSplitVersion(t, { hoId: H2, effectiveFrom: '2026-08', lines: [{ companyTenantId: C, shareBps: 2500 }, { companyTenantId: D, shareBps: 5000 }], actorId: ceo })
    for (const h of [H1, H2]) {
      await confirmBooks(t, h, { note: 'CA confirmed the accounts', taxAnswer: 'No tax on the recharge — CA confirmed' }, ceo)
      await setRecharge(t, h, { enabled: true, fromPeriod: '2026-08' }, ceo)
    }
  }, { timeout: 30_000 })
  await cost(H1, '2026-08-10', 100_000_000)
  await cost(H2, '2026-08-10', 40_000_000)
  await cost(H1, '2026-09-10', 10_000_000)
  await cost(H2, '2026-09-10', 4_000_000)

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => { await api.register(rechargeRunRoutes, { prefix: BASE }) }, { prefix: '/api/v1' })
  await app.ready()
}, 90_000)

afterAll(async () => {
  await app?.close()
})

describe('a company under two head offices', () => {
  it('has a Due-to and a charges account per head office', async () => {
    const dueTo = await prisma.account.findMany({ where: { tenantId: C, controlledBy: 'intercompany', type: 'liability' }, select: { counterpartyTenantId: true } })
    expect(dueTo.map((a) => a.counterpartyTenantId).sort()).toEqual([H1, H2].sort())
    const links = await prisma.headOfficeLink.findMany({ where: { companyTenantId: C }, select: { chargesAccountId: true } })
    expect(new Set(links.map((l) => l.chargesAccountId)).size).toBe(2)
  })

  it("C's close names both head offices until both have recharged, then the one still missing", async () => {
    let p = await charges.run(ctx(C, '2026-08-31', ['2026-08']))
    expect(p?.count).toBe(2)
    expect(p?.detail).toContain('Head Office One')
    expect(p?.detail).toContain('Head Office Two')

    const r1 = await recharge(H1, '2026-08')
    expect(r1.lines.map((l: { companyTenantId: string; amountCents: number }) => [l.companyTenantId, l.amountCents])).toEqual([[C, 40_000_000]])
    p = await charges.run(ctx(C, '2026-08-31', ['2026-08']))
    expect(p?.count).toBe(1)
    expect(p?.detail).not.toContain('Head Office One')
    expect(p?.detail).toContain('Head Office Two')

    await recharge(H2, '2026-08')
    expect(await charges.run(ctx(C, '2026-08-31', ['2026-08']))).toBeNull()
  })

  it('each run touched only its own pair, and each pair agrees across the two books', async () => {
    const h1 = await pairBalances(prisma, H1, C)
    const h2 = await pairBalances(prisma, H2, C)
    expect(h1.aDueFromB).toBe(40_000_000)
    expect(h1.bDueToA).toBe(40_000_000)
    expect(h2.aDueFromB).toBe(10_000_000)
    expect(h2.bDueToA).toBe(10_000_000)
    expect(h1.mismatchCents).toBe(0)
    expect(h2.mismatchCents).toBe(0)
    expect((await pairBalances(prisma, H2, D)).aDueFromB).toBe(20_000_000)
    // H1 never touched D.
    expect(await prisma.account.count({ where: { tenantId: D, counterpartyTenantId: H1 } })).toBe(0)
    const h1Transfers = await prisma.intercompanyTransfer.findMany({ where: { source: 'ho_recharge', OR: [{ tenantId: H1 }, { counterpartyTenantId: H1 }] } })
    for (const t of h1Transfers) expect([t.tenantId, t.counterpartyTenantId].sort()).toEqual([H1, C].sort())
  })

  it('ending H2 → C leaves H1 alone, and a later H2 month does not charge C', async () => {
    const ceo = users.ceo!.id
    const ended = await prisma.$transaction((t) => endLink(t, { hoId: H2, companyId: C, reason: 'C moves to Head Office One only', lastChargedPeriod: '2026-08', actorId: ceo }), { timeout: 30_000 })
    expect(ended.autoSplit?.effectiveFrom).toBe('2026-09')
    // Ending a link clears the confirmation and switches recharge off — confirm again.
    await prisma.$transaction(async (t) => {
      await confirmBooks(t, H2, { note: 'CA re-confirmed the accounts', taxAnswer: 'No tax on the recharge — CA confirmed' }, ceo)
      await setRecharge(t, H2, { enabled: true, fromPeriod: '2026-08' }, ceo)
    })

    // C's September close waits only for H1 now.
    const p = await charges.run(ctx(C, '2026-09-30', ['2026-09']))
    expect(p?.count).toBe(1)
    expect(p?.detail).toContain('Head Office One')
    expect(p?.detail).not.toContain('Head Office Two')

    const r2 = await recharge(H2, '2026-09')
    expect(r2.lines.map((l: { companyTenantId: string }) => l.companyTenantId)).toEqual([D])
    expect((await pairBalances(prisma, H2, C)).aDueFromB).toBe(10_000_000)

    const r1 = await recharge(H1, '2026-09')
    expect(r1.lines.map((l: { companyTenantId: string; amountCents: number }) => [l.companyTenantId, l.amountCents])).toEqual([[C, 4_000_000]])
    expect((await pairBalances(prisma, H1, C)).aDueFromB).toBe(44_000_000)
    expect(await charges.run(ctx(C, '2026-09-30', ['2026-09']))).toBeNull()
  })
})
