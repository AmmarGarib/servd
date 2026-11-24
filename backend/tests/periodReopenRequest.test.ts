// Finance asks the CEO to reopen a closed period, and works in the month reopened at its request
// (owner, 2026-11-24: "Where to request to open a closed period…" → "Build both"; accounting/periodReopen.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { reopenedOpenToFinance, reopenedThrough } from '../src/modules/accounting/closedBooks.js'

const P = `prr${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@prr.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code

const SEPT_END = new Date('2026-09-30T18:59:59.999Z')
const AUG_END = new Date('2026-08-31T18:59:59.999Z')
const sept = new Date('2026-09-15T07:00:00Z')
const aug = new Date('2026-08-15T07:00:00Z')
const oct = new Date('2026-10-10T07:00:00Z')
const lines = [
  { accountCode: '6140', type: 'debit' as const, amountCents: 10_000 },
  { accountCode: '1010', type: 'credit' as const, amountCents: 10_000 },
]
const post = (t: string, id: string, entryDate: Date, postedBy: string) =>
  postJournalEntry({ tenantId: t, sourceType: 'manual', sourceId: `${P}-${id}`, description: id, entryDate, postedBy, lines })
const R = '/accounting/period-close/reopen-requests'

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) await ensureChartOfAccounts(t)
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('fin2A', 'finance', [T.A])
  await mkUser('mgrA', 'manager', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('ceoB', 'admin', [T.B])
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(accountingRoutes, { prefix: '/accounting' }) }, { prefix: '/api/v1' })
  await app.ready()
  await post(T.A, 'sept-old', sept, U['finA']!.id)
  await post(T.A, 'aug-old', aug, U['finA']!.id)
  await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: AUG_END, lockedBy: U['ceoA']!.id } })
  await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: SEPT_END, lockedBy: U['ceoA']!.id } })
}, 120_000)

afterAll(async () => { await app?.close() })

describe('finance asks the CEO to reopen a closed period', () => {
  let reqId = ''
  it('who may ask; nothing changes; one pending per company; another company sees nothing', async () => {
    expect((await call('mgrA', 'POST', R, { reason: 'A September bill came in late' })).statusCode).toBe(403)
    expect((await call('finA', 'POST', R, { reason: 'short' })).statusCode).toBe(400)
    expect(code(await call('finB', 'POST', R, { reason: 'A September bill came in late' }))).toBe('NOTHING_TO_REOPEN')
    expect(code(await call('ceoA', 'POST', R, { reason: 'A September bill came in late' }))).toBe('CEO_REOPENS_DIRECTLY')
    const r = await call('finA', 'POST', R, { reason: 'A September bill came in late' })
    expect(r.statusCode, r.body).toBe(202)
    reqId = r.json().request.id
    expect(r.json().request).toMatchObject({ tenantId: T.A, status: 'pending', requestedById: U['finA']!.id })
    expect(new Date(r.json().request.lockedThrough).getTime()).toBe(SEPT_END.getTime())
    expect(await prisma.periodLock.count({ where: { tenantId: T.A } })).toBe(2)
    expect(code(await call('fin2A', 'POST', R, { reason: 'Another reason to reopen it' }))).toBe('REOPEN_PENDING')
    await expect(post(T.A, 'sept-still-closed', sept, U['finA']!.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    // Lists: company A's finance and CEO see it; company B sees none and cannot touch it.
    expect((await call('finA', 'GET', `${R}?status=pending`)).json().items.map((x: { id: string }) => x.id)).toEqual([reqId])
    expect((await call('finB', 'GET', `${R}?status=pending`)).json().items).toEqual([])
    expect((await call('ceoB', 'POST', `${R}/${reqId}/approve`, {})).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${R}/${reqId}/withdraw`, {})).statusCode).toBe(404)
    // Finance never decides; only the asker (or the CEO) withdraws.
    expect((await call('finA', 'POST', `${R}/${reqId}/approve`, {})).statusCode).toBe(403)
    expect((await call('fin2A', 'POST', `${R}/${reqId}/withdraw`, {})).statusCode).toBe(403)
  })

  it('reject needs a note and keeps the books closed; withdraw by the asker', async () => {
    expect((await call('ceoA', 'POST', `${R}/${reqId}/reject`, { note: 'no' })).statusCode).toBe(400)
    expect((await call('ceoA', 'POST', `${R}/${reqId}/reject`, { note: 'Post it in October instead' })).statusCode).toBe(200)
    expect(await prisma.periodLock.count({ where: { tenantId: T.A } })).toBe(2)
    expect(code(await call('ceoA', 'POST', `${R}/${reqId}/approve`, {}))).toBe('REQUEST_NOT_PENDING')
    const again = await call('finA', 'POST', R, { reason: 'It really belongs to September' })
    expect(again.statusCode).toBe(202)
    expect((await call('finA', 'POST', `${R}/${again.json().request.id}/withdraw`, {})).statusCode).toBe(200)
    expect(await reopenedThrough(prisma, T.A)).toBeNull()
  })

  it('approved: the latest close is reopened and finance works in that month — not in the months still closed', async () => {
    const ask = await call('finA', 'POST', R, { reason: 'The auditor asked for a September correction' })
    expect(ask.statusCode).toBe(202)
    const yes = await call('ceoA', 'POST', `${R}/${ask.json().request.id}/approve`, {})
    expect(yes.statusCode, yes.body).toBe(200)
    expect(code(await call('ceoA', 'POST', `${R}/${ask.json().request.id}/approve`, {}))).toBe('REQUEST_NOT_PENDING')
    const locks = await prisma.periodLock.findMany({ where: { tenantId: T.A } })
    expect(locks.map((l) => l.lockedThrough.getTime())).toEqual([AUG_END.getTime()])
    expect((await reopenedThrough(prisma, T.A))?.getTime()).toBe(SEPT_END.getTime())
    expect(await reopenedOpenToFinance(prisma, T.A)).toBe(true)
    const state = (await call('finA', 'GET', '/accounting/period-close')).json()
    expect(state.reopenedForFinance).toBe(true)
    // Finance (any finance login of the company holding accounting) posts and cancels in September.
    expect((await post(T.A, 'sept-fin', sept, U['finA']!.id)).posted).toBe(true)
    expect((await post(T.A, 'sept-fin2', sept, U['fin2A']!.id)).posted).toBe(true)
    expect((await reverseJournalEntry(T.A, 'manual', `${P}-sept-old`, 'wrong account', { postedBy: U['finA']!.id, entryDate: sept })).posted).toBe(true)
    // A manager, and another company's finance, stay out; August is still closed for everyone.
    await expect(post(T.A, 'sept-mgr', sept, U['mgrA']!.id)).rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS' })
    await expect(post(T.A, 'sept-finB', sept, U['finB']!.id)).rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS' })
    await expect(post(T.A, 'aug-fin', aug, U['finA']!.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    await expect(reverseJournalEntry(T.A, 'manual', `${P}-aug-old`, 'x', { postedBy: U['finA']!.id, entryDate: oct })).rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS' })
    // The audit trail and the flag are there.
    expect(await prisma.auditLog.count({ where: { tenantId: T.A, action: 'period.reopen' } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: T.A, kind: 'period_reopened' } })).toBe(1)
  })

  it('a request goes stale when the close changes; a month the CEO reopens directly stays the CEO\'s', async () => {
    // Asked for August, then the CEO reopens August directly: the request can no longer be approved as asked.
    const ask = await call('finA', 'POST', R, { reason: 'August needs a correction too' })
    expect(ask.statusCode).toBe(202)
    await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date('2026-09-10T18:59:59.999Z'), lockedBy: U['ceoA']!.id } })
    expect(code(await call('ceoA', 'POST', `${R}/${ask.json().request.id}/approve`, {}))).toBe('CLOSE_CHANGED')
    expect((await prisma.periodReopenRequest.findUniqueOrThrow({ where: { id: ask.json().request.id } })).status).toBe('pending')
    expect((await call('finA', 'GET', `${R}?status=pending`)).json().items[0].blockedBy).toContain('closed through')
    expect((await call('ceoA', 'POST', `${R}/${ask.json().request.id}/reject`, { note: 'The close moved — ask again' })).statusCode).toBe(200)

    // Company B: the CEO reopens directly — finance of B may NOT post into it.
    await post(T.B, 'b-sept', sept, U['finB']!.id)
    await prisma.periodLock.create({ data: { tenantId: T.B, lockedThrough: SEPT_END, lockedBy: U['ceoB']!.id } })
    const direct = await call('ceoB', 'POST', '/accounting/period-close/reopen', { reason: 'CEO correction only' })
    expect(direct.statusCode, direct.body).toBe(200)
    expect(await reopenedOpenToFinance(prisma, T.B)).toBe(false)
    await expect(post(T.B, 'b-sept-fin', sept, U['finB']!.id)).rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS' })
    expect((await post(T.B, 'b-sept-ceo', sept, U['ceoB']!.id)).posted).toBe(true)
  })

  it('which period: "from" removes every close covering that day or later and keeps the earlier days closed', async () => {
    await prisma.periodLock.deleteMany({ where: { tenantId: T.B } })
    await prisma.periodLock.create({ data: { tenantId: T.B, lockedThrough: AUG_END, lockedBy: U['ceoB']!.id } })
    await prisma.periodLock.create({ data: { tenantId: T.B, lockedThrough: SEPT_END, lockedBy: U['ceoB']!.id } })
    expect(code(await call('finB', 'POST', R, { reason: 'October is not closed at all', from: '2026-10-05' }))).toBe('FROM_NOT_CLOSED')
    const ask = await call('finB', 'POST', R, { reason: 'Split expenses from mid August', from: '2026-08-10' })
    expect(ask.statusCode, ask.body).toBe(202)
    const row = (await call('finB', 'GET', `${R}?status=pending`)).json().items[0]
    expect(row.reopenFromLabel).toBeTruthy()
    // Nothing changed yet.
    expect(await prisma.periodLock.count({ where: { tenantId: T.B } })).toBe(2)
    const ok = await call('ceoB', 'POST', `${R}/${ask.json().request.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    // Both closes are gone; the days before 10 August stay closed.
    const locks = await prisma.periodLock.findMany({ where: { tenantId: T.B } })
    expect(locks.map((l) => l.lockedThrough.toISOString())).toEqual(['2026-08-09T18:59:59.999Z'])
    expect(await reopenedOpenToFinance(prisma, T.B)).toBe(true)
    expect((await post(T.B, 'b-aug-fin', aug, U['finB']!.id)).posted).toBe(true)
    expect((await post(T.B, 'b-sept-fin2', sept, U['finB']!.id)).posted).toBe(true)
    await expect(post(T.B, 'b-early-aug', new Date('2026-08-05T07:00:00Z'), U['ceoB']!.id)).rejects.toBeTruthy()

    // The CEO's direct reopen takes the same date; a date on the day after an earlier close writes no extra lock.
    await prisma.periodLock.create({ data: { tenantId: T.B, lockedThrough: SEPT_END, lockedBy: U['ceoB']!.id } })
    const direct = await call('ceoB', 'POST', '/accounting/period-close/reopen', { reason: 'Open from 10 August again', from: '2026-08-10' })
    expect(direct.statusCode, direct.body).toBe(200)
    expect((await prisma.periodLock.findMany({ where: { tenantId: T.B } })).map((l) => l.lockedThrough.toISOString())).toEqual(['2026-08-09T18:59:59.999Z'])
  })
})
