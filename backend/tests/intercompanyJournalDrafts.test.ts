// Journals between companies (owner, 2026-11-12; accounting/mirrorDrafts.ts is the contract):
//   - an account is linked to another company + its account (both of them; the editor belongs to both — 403);
//   - a manual PV on the linked account raises ONE pre-filled RV draft in the other company (lines flipped, the linked
//     line on the counterpart account), and tells its finance + CEO (no approval step);
//   - only the drafted company books it (through POST /accounting/journal {mirrorDraftId}) or dismisses it; the other
//     company reads it, writes 404; booking twice is 409; booking it never raises a draft back;
//   - the CEO(s) are told when it is booked; cancelling a source with a draft still waiting withdraws the draft.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { setupRoutes } = await import('../src/modules/setup/routes.js')
const { flushNotifications } = await import('../src/lib/staffNotify.js')

const P = `icj-${Date.now()}`
let app: FastifyInstance
let A: string, B: string
const U: Record<string, { id: string; token: string }> = {}
const acct: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@icj.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0]!, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, company?: string) =>
  app.inject({ method, url, headers: { authorization: U[who]!.token, ...(company ? { 'x-servd-active-tenant': company } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'GS test', slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: 'Flipd test', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  acct.aLoan = (await prisma.account.create({ data: { tenantId: A, code: '1381', name: 'Loan to Flipd', type: 'asset' } })).id
  acct.bPay = (await prisma.account.create({ data: { tenantId: B, code: '2291', name: 'Payable to GS', type: 'liability' } })).id
  acct.aCash = (await prisma.account.findFirstOrThrow({ where: { tenantId: A, code: '1010' } })).id
  await mkUser('ceo', 'admin', [A, B])
  await mkUser('finA', 'finance', [A])
  await mkUser('finB', 'finance', [B])
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) { if (process.env.ICJ_DEBUG) console.error('ZOD', JSON.stringify(err.issues)); return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } }) }
    if (process.env.ICJ_DEBUG) console.error('ERR', err)
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

const pv = (desc: string) => ({
  description: desc, voucherKind: 'PV',
  lines: [{ accountId: acct.aLoan, type: 'debit', amountCents: 500_000 }, { accountId: acct.aCash, type: 'credit', amountCents: 500_000 }],
})

describe('journals between companies', () => {
  it('links the account: both or neither, the other company\'s account must exist, the editor in both companies', async () => {
    expect(code(await call('ceo', 'PATCH', `/setup/chart-of-accounts/${acct.aLoan}`, { relatedTenantId: B }, A))).toBe('RELATED_BOTH_OR_NONE')
    expect(code(await call('ceo', 'PATCH', `/setup/chart-of-accounts/${acct.aLoan}`, { relatedTenantId: B, relatedAccountCode: '9999' }, A))).toBe('RELATED_ACCOUNT_NOT_FOUND')
    expect((await call('finA', 'PATCH', `/setup/chart-of-accounts/${acct.aLoan}`, { relatedTenantId: B, relatedAccountCode: '2291' })).statusCode).toBe(403)
    const ok = await call('ceo', 'PATCH', `/setup/chart-of-accounts/${acct.aLoan}`, { relatedTenantId: B, relatedAccountCode: '2291' }, A)
    expect(ok.statusCode, ok.body).toBe(200)
    // And back: Flipd's payable to GS points at GS's loan (a booked draft never ping-pongs).
    expect((await call('ceo', 'PATCH', `/setup/chart-of-accounts/${acct.bPay}`, { relatedTenantId: A, relatedAccountCode: '1381' }, B)).statusCode).toBe(200)
  })

  let draftId = ''
  it('a PV on the linked account raises a pre-filled RV draft in the other company, told to its finance + CEO', async () => {
    const r = await call('finA', 'POST', '/accounting/journal', pv('Cash transferred to Flipd'))
    expect(r.statusCode, r.body).toBe(201)
    await flushNotifications()
    const d = await prisma.intercompanyJournalDraft.findFirstOrThrow({ where: { sourceEntryId: r.json().id } })
    draftId = d.id
    expect(d).toMatchObject({ tenantId: B, sourceTenantId: A, status: 'pending', voucherKind: 'RV' })
    const lines = d.lines as Array<{ accountId: string | null; accountCode: string | null; type: string; amountCents: number }>
    expect(lines.find((l) => l.accountCode === '2291')).toMatchObject({ accountId: acct.bPay, type: 'credit', amountCents: 500_000 })
    expect(lines.find((l) => l.accountCode === '1010')).toMatchObject({ type: 'debit', amountCents: 500_000 })
    const told = await prisma.staffNotification.findMany({ where: { kind: 'journal.intercompany', tenantId: B, entityId: r.json().id } })
    expect(told.map((n) => n.userId).sort()).toEqual([U.ceo!.id, U.finB!.id].sort())
  })

  it('both companies read it; only the drafted company dismisses / books it', async () => {
    const forB = (await call('finB', 'GET', '/accounting/journal-drafts')).json() as Array<{ id: string; mine: boolean }>
    expect(forB.find((x) => x.id === draftId)?.mine).toBe(true)
    const forA = (await call('finA', 'GET', '/accounting/journal-drafts')).json() as Array<{ id: string; mine: boolean }>
    expect(forA.find((x) => x.id === draftId)?.mine).toBe(false)
    expect((await call('finA', 'POST', `/accounting/journal-drafts/${draftId}/dismiss`, { note: 'not ours to dismiss' })).statusCode).toBe(404)
    const d = await prisma.intercompanyJournalDraft.findUniqueOrThrow({ where: { id: draftId } })
    const lines = (d.lines as Array<{ accountId: string; type: string; amountCents: number }>).map((l) => ({ accountId: l.accountId, type: l.type, amountCents: l.amountCents }))
    // finA cannot book it into A (the draft is B's): 404.
    expect([404, 422]).toContain((await call('finA', 'POST', '/accounting/journal', { description: d.description, voucherKind: 'RV', lines, mirrorDraftId: draftId })).statusCode)
    expect((await prisma.intercompanyJournalDraft.findUniqueOrThrow({ where: { id: draftId } })).status).toBe('pending')
    const booked = await call('finB', 'POST', '/accounting/journal', { description: d.description, voucherKind: 'RV', lines, mirrorDraftId: draftId })
    expect(booked.statusCode, booked.body).toBe(201)
    await flushNotifications()
    const after = await prisma.intercompanyJournalDraft.findUniqueOrThrow({ where: { id: draftId } })
    expect(after).toMatchObject({ status: 'posted', postedEntryId: booked.json().id, decidedById: U.finB!.id })
    // Twice: no. And Flipd's booking never raises a draft back in GS.
    expect(code(await call('finB', 'POST', '/accounting/journal', { description: d.description, voucherKind: 'RV', lines, mirrorDraftId: draftId }))).toBe('DRAFT_NOT_PENDING')
    expect(await prisma.intercompanyJournalDraft.count({ where: { tenantId: A, sourceTenantId: B } })).toBe(0)
    // The CEO is told it was booked.
    expect(await prisma.staffNotification.count({ where: { kind: 'journal.intercompany', userId: U.ceo!.id, entityId: draftId } })).toBeGreaterThan(0)
  })

  it('cancelling a source whose draft still waits withdraws it; a dismiss needs a note', async () => {
    const r = await call('ceo', 'POST', '/accounting/journal', pv('Second transfer'), A)
    expect(r.statusCode, r.body).toBe(201)
    const d = await prisma.intercompanyJournalDraft.findFirstOrThrow({ where: { sourceEntryId: r.json().id } })
    expect((await call('finB', 'POST', `/accounting/journal-drafts/${d.id}/dismiss`, { note: 'short' })).statusCode).toBe(400)
    const rev = await call('ceo', 'POST', `/accounting/journal/${r.json().id}/reverse`, { reason: 'Booked twice by mistake' }, A)
    expect(rev.statusCode, rev.body).toBeLessThan(300)
    expect((await prisma.intercompanyJournalDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('withdrawn')
  })
})
