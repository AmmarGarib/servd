// Manual journals and controlled accounts (FA): a line on a fixed-asset
// register account (1500–1599, 2012) needs the CEO's registerOverride reason
// (else the posting engine's 422 REGISTER_CONTROLLED_ACCOUNT); with it the
// entry posts, is audited and raises fixed_asset_gl_mismatch. Inter-company
// accounts are never posted to by hand (422 INTERCOMPANY_ACCOUNT_CONTROLLED).
// Accounts of another company are 422 ACCOUNT_NOT_IN_COMPANY.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'

let A: string
let B: string
let dueFromB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.mjc@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const acct = async (tenantId: string, code: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId, code }, select: { id: true } })).id

async function journal(who: string, lines: Array<{ accountId: string; type: 'debit' | 'credit'; amountCents: number }>, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/accounting/journal',
    payload: { description: 'Correction', entryDate: '2026-09-15T07:00:00.000Z', lines, ...extra },
    headers: { authorization: `Bearer ${users[who]!.token}`, 'x-servd-active-tenant': A },
  })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Journal Foods', slug: 'mjc-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Journal Viva', slug: 'mjc-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  dueFromB = (await prisma.account.create({ data: {
    tenantId: A, code: '1450', name: 'Due from Journal Viva', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: B,
  } })).id
  await mkUser('ceo', 'admin', A, [A, B])
  await mkUser('fin', 'finance', A, [A])
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
})

afterAll(async () => {
  await prisma.account.update({ where: { id: dueFromB }, data: { controlledBy: null, counterpartyTenantId: null } }).catch(() => {})
  await app.close()
})

describe('register-controlled accounts need the CEO\'s reason', () => {
  it('a JE to 1510 without registerOverride is 422 REGISTER_CONTROLLED_ACCOUNT, nothing posted', async () => {
    const lines = [
      { accountId: await acct(A, '1510'), type: 'debit' as const, amountCents: 1_000_000 },
      { accountId: await acct(A, '1020'), type: 'credit' as const, amountCents: 1_000_000 },
    ]
    const res = await journal('ceo', lines)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('REGISTER_CONTROLLED_ACCOUNT')
    const short = await journal('ceo', lines, { registerOverride: { reason: 'oops' } })
    expect(short.statusCode).toBe(422)
    expect(short.json().error.code).toBe('REGISTER_CONTROLLED_ACCOUNT')
    expect(await prisma.journalLine.count({ where: { accountId: lines[0]!.accountId } })).toBe(0)
  })

  it('with the override it posts, is audited and flagged fixed_asset_gl_mismatch in the company', async () => {
    const lines = [
      { accountId: await acct(A, '1510'), type: 'debit' as const, amountCents: 1_000_000 },
      { accountId: await acct(A, '1020'), type: 'credit' as const, amountCents: 1_000_000 },
    ]
    const res = await journal('ceo', lines, { registerOverride: { reason: 'Oven bought before servd, CA instruction' } })
    expect(res.statusCode).toBe(201)
    const entry = res.json() as { id: string; tenantId: string }
    expect(entry.tenantId).toBe(A)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'journal.register_override', entityId: entry.id } })
    expect(audit?.tenantId).toBe(A)
    expect(audit?.metadata).toMatchObject({ reason: 'Oven bought before servd, CA instruction' })
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'fixed_asset_gl_mismatch', entityId: entry.id } })
    expect(flag).toMatchObject({ tenantId: A, severity: 'high' })
    expect(Number(flag!.amountCents)).toBe(1_000_000)
  })

  it('a register-override JE can be reversed (its reason carried as the override): 201, audited, its mismatch flag closed', async () => {
    const lines = [
      { accountId: await acct(A, '1510'), type: 'debit' as const, amountCents: 200_000 },
      { accountId: await acct(A, '1020'), type: 'credit' as const, amountCents: 200_000 },
    ]
    const res = await journal('ceo', lines, { registerOverride: { reason: 'Legacy opening balance, CA said so' } })
    expect(res.statusCode).toBe(201)
    const entry = res.json() as { id: string }
    const short = await app.inject({
      method: 'POST', url: `/accounting/journal/${entry.id}/reverse`, payload: { reason: 'wrong' },
      headers: { authorization: `Bearer ${users.ceo!.token}`, 'x-servd-active-tenant': A },
    })
    expect(short.statusCode).toBe(422)
    expect(short.json().error.code).toBe('REGISTER_CONTROLLED_ACCOUNT')
    const rev = await app.inject({
      method: 'POST', url: `/accounting/journal/${entry.id}/reverse`, payload: { reason: 'Wrong amount entered — redo it' },
      headers: { authorization: `Bearer ${users.ceo!.token}`, 'x-servd-active-tenant': A },
    })
    expect(rev.statusCode, rev.body).toBe(201)
    const reversal = rev.json() as { id: string; tenantId: string; lines: Array<{ account: { code: string }; type: string; amountCents: number }> }
    expect(reversal.tenantId).toBe(A)
    expect(reversal.lines.find((l) => l.account.code === '1510')).toMatchObject({ type: 'credit' })
    expect(await prisma.auditLog.count({ where: { action: 'journal.register_override', entityId: reversal.id, tenantId: A } })).toBe(1)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'fixed_asset_gl_mismatch', entityId: entry.id } })
    expect(flag.status).toBe('resolved')
  })

  it('an ordinary JE with a stray override reason raises no register flag', async () => {
    const res = await journal('ceo', [
      { accountId: await acct(A, '6010'), type: 'debit', amountCents: 50_000 },
      { accountId: await acct(A, '1020'), type: 'credit', amountCents: 50_000 },
    ], { registerOverride: { reason: 'Not a register account at all' } })
    expect(res.statusCode).toBe(201)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'fixed_asset_gl_mismatch', entityId: res.json().id } })).toBe(0)
  })
})

describe('inter-company accounts and other companies', () => {
  it('a JE to a Due-from account is 422 INTERCOMPANY_ACCOUNT_CONTROLLED, even with an override', async () => {
    const res = await journal('ceo', [
      { accountId: dueFromB, type: 'debit', amountCents: 10_000 },
      { accountId: await acct(A, '1020'), type: 'credit', amountCents: 10_000 },
    ], { registerOverride: { reason: 'Trying to settle by hand here' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('INTERCOMPANY_ACCOUNT_CONTROLLED')
  })

  it('another company\'s account is 422 ACCOUNT_NOT_IN_COMPANY; finance posts a manual journal (owner, 2026-10-16) but never a register override', async () => {
    const res = await journal('ceo', [
      { accountId: await acct(B, '1510'), type: 'debit', amountCents: 10_000 },
      { accountId: await acct(A, '1020'), type: 'credit', amountCents: 10_000 },
    ], { registerOverride: { reason: 'Wrong company account used' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_NOT_IN_COMPANY')
    const fin = await journal('fin', [
      { accountId: await acct(A, '6010'), type: 'debit', amountCents: 10_000 },
      { accountId: await acct(A, '1020'), type: 'credit', amountCents: 10_000 },
    ])
    expect(fin.statusCode, fin.body).toBe(201)
    const reg = await journal('fin', [
      { accountId: await acct(A, '1510'), type: 'debit', amountCents: 10_000 },
      { accountId: await acct(A, '1020'), type: 'credit', amountCents: 10_000 },
    ], { registerOverride: { reason: 'Finance trying the register' } })
    expect(reg.statusCode).toBe(403)
    expect(reg.json().error.code).toBe('REGISTER_OVERRIDE_CEO_ONLY')
  })
})

// Owner, 2026-10-16: "journal entries should not require CEO's approval to be
// booked … Finance should have access to pass new entry / edit / cancel" — and
// 2026-10-23: a money edit or cancel of an EXISTING entry needs the CEO's approval.
describe('finance posts, edits and cancels manual journals directly', () => {
  const as = (who: string, method: 'POST', url: string, payload: unknown) =>
    app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}`, 'x-servd-active-tenant': A } })
  beforeAll(async () => {
    await mkUser('finB', 'finance', B, [B])
    await mkUser('mgmt', 'management', A, [A])
    await mkUser('cash', 'cashier', A, [A])
    await mkUser('finNoMod', 'finance', A, [A])
    await prisma.user.update({ where: { id: users['finNoMod']!.id }, data: { moduleDeny: ['accounting'] } })
  })
  const two = async (cents: number) => [
    { accountId: await acct(A, '6010'), type: 'debit' as const, amountCents: cents },
    { accountId: await acct(A, '1020'), type: 'credit' as const, amountCents: cents },
  ]

  // Owner, 2026-10-23: finance's cancel / money edit of an existing entry waits for the CEO (202, a journal request).
  it('finance cancels: 202 for the CEO; once (CHANGE_PENDING); company B finance gets 404; the CEO approves', async () => {
    const e = (await journal('fin', await two(20_000))).json()
    expect((await as('finB', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Not ours' })).statusCode).toBe(404)
    const r = await as('fin', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Posted twice by mistake' })
    expect(r.statusCode, r.body).toBe(202)
    expect((await as('fin', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Again please' })).statusCode).toBe(409)
    const ok = await as('ceo', 'POST', `/accounting/journal-requests/${r.json().request.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await as('ceo', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Again please' })).statusCode).toBe(409)
  })

  it('finance edits an entry: on the CEO\'s approval the old one is reversed and the corrected one posted, in its company', async () => {
    const e = (await journal('fin', await two(30_000))).json()
    const raised = await as('fin', 'POST', `/accounting/journal/${e.id}/amend`, {
      reason: 'Wrong amount', description: 'Correction (fixed)', entryDate: '2026-09-15T07:00:00.000Z', lines: await two(35_000),
    })
    expect(raised.statusCode, raised.body).toBe(202)
    const ok = await as('ceo', 'POST', `/accounting/journal-requests/${raised.json().request.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    const corrected = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ok.json().entryId } })
    expect(corrected.tenantId).toBe(A)
    const reversal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ok.json().reversalId }, include: { lines: true } })
    expect(reversal.lines.reduce((t, l) => t + Number(l.amountCents), 0)).toBe(60_000)
    expect(await prisma.auditLog.count({ where: { entityId: reversal.id, action: 'journal.reverse' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { entityId: corrected.id, action: 'journal.manual' } })).toBe(1)
    expect((await as('finB', 'POST', `/accounting/journal/${corrected.id}/amend`, { reason: 'Not ours', description: 'x', lines: await two(1) })).statusCode).toBe(404)
  })

  it('an edit whose corrected lines are refused is refused up front; nothing is booked or asked for', async () => {
    const e = (await journal('fin', await two(40_000))).json()
    const bad = await as('fin', 'POST', `/accounting/journal/${e.id}/amend`, {
      reason: 'Move to the register', description: 'x', lines: [
        { accountId: await acct(A, '1510'), type: 'debit', amountCents: 40_000 },
        { accountId: await acct(A, '1020'), type: 'credit', amountCents: 40_000 },
      ],
    })
    expect(bad.statusCode).toBe(422)
    // The CEO's direct edit with the same lines is refused by the engine and rolls back the reversal too.
    const ceoBad = await as('ceo', 'POST', `/accounting/journal/${e.id}/amend`, {
      reason: 'Move to the register', description: 'x', lines: [
        { accountId: await acct(A, '1510'), type: 'debit', amountCents: 40_000 },
        { accountId: await acct(A, '1020'), type: 'credit', amountCents: 40_000 },
      ],
    })
    expect(ceoBad.statusCode).toBe(422)
    expect((await as('ceo', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Cancel it now' })).statusCode).toBe(201)
  })

  it('management, cashier and finance without the accounting module are refused', async () => {
    for (const who of ['mgmt', 'cash', 'finNoMod']) {
      expect((await journal(who, await two(1_000))).statusCode, who).toBe(403)
    }
  })
})
