// Journal requests (head office D1/D3): Finance prepares a manual journal, the
// CEO approves it — accounting/journalRequests.ts on manualJournal.ts.
//
//   - two companies: a create binds to the ACTIVE company; company B's finance
//     gets 404 on company A's request (read, edit, submit, approve);
//   - the cycle draft → submitted → returned → resubmitted → posted;
//   - the posted entry `manual:<requestId>` is the entry a direct
//     POST /accounting/journal makes, and the CEO's reverse route undoes it;
//   - a closed month → 422 PERIOD_LOCKED and the request stays submitted;
//   - only the preparer edits / sends / withdraws (403 NOT_YOUR_REQUEST);
//   - the preparer, as an approver (a Finance delegate once the owner switches
//     hand-over on), gets 403 SELF_APPROVAL_BLOCKED; another delegate posts it;
//   - kind reverse is CEO only (a delegate gets 403), and the CEO posts it;
//   - a delegation grant for journal_request → 422 SECTION_NOT_YET_DELEGABLE;
//   - the approvals inbox lists a submitted request for the CEO.
//
// Real database (the disposable test DB); routes through Fastify inject.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const R = await import('../src/lib/approvalRights.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')

const P = `jr${Date.now()}`
let A = ''
let B = ''
let HO = ''
let app: FastifyInstance
const U: Record<string, { id: string; token: string; tenantId: string }> = {}

async function mkUser(key: string, role: string, members: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@jr.pk`, password: 'x', role: role as 'admin', tenantId: members[0]!,
      isActive: true, accountStatus: 'active',
      tenantMemberships: { create: members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken, tenantId: members[0]! }
}

const acct = async (tenantId: string, code: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId, code }, select: { id: true } })).id

function call(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, tenant?: string) {
  return app.inject({
    method, url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${U[who]!.token}`, 'x-servd-active-tenant': tenant ?? U[who]!.tenantId },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code

let lines: Array<{ accountId: string; type: 'debit' | 'credit'; amountCents: number; memo?: string }>

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `${P} Foods`, slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `${P} Viva`, slug: `${P}-b` } })).id
  HO = (await prisma.tenant.create({ data: { name: `${P} HO`, slug: `${P}-ho`, kind: 'head_office' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  await mkUser('ceo', 'admin', [A, B, HO])
  await mkUser('fin', 'finance', [A])
  await mkUser('fin2', 'finance', [A])
  await mkUser('finB', 'finance', [B])
  await mkUser('hodFin', 'finance', [A, HO])   // a head-office Finance HOD who is also in A
  await mkUser('hodFin2', 'finance', [HO])     // another head-office Finance HOD (reach only)
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: U.ceo!.id, startedAt: new Date('2026-01-01') } })
  lines = [
    { accountId: await acct(A, '6010'), type: 'debit', amountCents: 250_000, memo: 'September rent accrual' },
    { accountId: await acct(A, '1020'), type: 'credit', amountCents: 250_000 },
  ]

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await prisma.periodLock.deleteMany({ where: { tenantId: { in: [A, B] } } }).catch(() => {})
  await app?.close()
})

const draft = (who: string, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', '/accounting/journal-requests', { description: 'Rent accrual', reference: 'SEP-RENT', entryDate: '2026-10-05T07:00:00.000Z', lines, ...extra })

describe('two companies', () => {
  it('a create binds to the active company; company B gets 404 on it', async () => {
    const res = await draft('fin')
    expect(res.statusCode, res.body).toBe(201)
    const r = res.json().request
    expect(r).toMatchObject({ tenantId: A, kind: 'post', status: 'draft', totalCents: 250_000, preparedById: U.fin!.id, preparedByIds: [U.fin!.id], viaHeadOfficeId: null })

    for (const [m, url, body] of [
      ['GET', `/accounting/journal-requests/${r.id}`, undefined],
      ['PATCH', `/accounting/journal-requests/${r.id}`, { description: 'x' }],
      ['POST', `/accounting/journal-requests/${r.id}/submit`, {}],
      ['POST', `/accounting/journal-requests/${r.id}/withdraw`, {}],
    ] as const) {
      const res2 = await call('finB', m, url, body)
      expect(res2.statusCode, `${m} ${url}`).toBe(404)
    }
    const list = await call('finB', 'GET', '/accounting/journal-requests')
    expect(list.statusCode).toBe(200)
    expect((list.json().requests as Array<{ id: string }>).some((x) => x.id === r.id)).toBe(false)
    // Submitted, B's finance still cannot decide it (404 — the id is not confirmed).
    expect((await call('fin', 'POST', `/accounting/journal-requests/${r.id}/submit`, {})).statusCode).toBe(200)
    expect((await call('finB', 'POST', `/accounting/journal-requests/${r.id}/approve`, {})).statusCode).toBe(404)
  })

  it('lines are checked exactly as the direct route checks them', async () => {
    const unbalanced = await draft('fin', { lines: [lines[0], { ...lines[1], amountCents: 1 }] })
    expect([unbalanced.statusCode, code(unbalanced)]).toEqual([422, 'UNBALANCED_ENTRY'])
    const foreign = await draft('fin', { lines: [lines[0], { ...lines[1], accountId: await acct(B, '1020') }] })
    expect([foreign.statusCode, code(foreign)]).toEqual([422, 'ACCOUNT_NOT_IN_COMPANY'])
    // Another company's finance cannot use A's accounts in its own request.
    const finance = await call('finB', 'POST', '/accounting/journal-requests', { description: 'x', lines })
    expect([finance.statusCode, code(finance)]).toEqual([422, 'ACCOUNT_NOT_IN_COMPANY'])
  })
})

describe('the cycle', () => {
  it('draft → submitted → returned → resubmitted → posted; the entry is a direct post\'s; the CEO reverse undoes it', async () => {
    const created = (await draft('fin')).json().request
    const id = created.id as string

    // Only the preparer edits / sends.
    expect([(await call('fin2', 'PATCH', `/accounting/journal-requests/${id}`, { description: 'x' })).statusCode]).toEqual([403])
    const other = await call('fin2', 'POST', `/accounting/journal-requests/${id}/submit`, {})
    expect([other.statusCode, code(other)]).toEqual([403, 'NOT_YOUR_REQUEST'])

    const sub = await call('fin', 'POST', `/accounting/journal-requests/${id}/submit`, {})
    expect(sub.statusCode, sub.body).toBe(200)
    expect(sub.json().request).toMatchObject({ status: 'submitted', submittedById: U.fin!.id })
    // Submitted: no edits.
    const locked = await call('fin', 'PATCH', `/accounting/journal-requests/${id}`, { description: 'x' })
    expect([locked.statusCode, code(locked)]).toEqual([409, 'REQUEST_NOT_EDITABLE'])
    // Finance cannot approve (the role path is the CEO's; hand-over is off).
    const notYours = await call('fin2', 'POST', `/accounting/journal-requests/${id}/approve`, {})
    expect([notYours.statusCode, code(notYours)]).toEqual([403, 'APPROVAL_NOT_YOURS'])

    // The inbox lists it for the CEO.
    const inbox = await call('ceo', 'GET', '/approvals', undefined, A)
    expect(inbox.statusCode, inbox.body).toBe(200)
    expect(JSON.stringify(inbox.json())).toContain(id)

    const back = await call('ceo', 'POST', `/accounting/journal-requests/${id}/reject`, { note: 'Use the accrual account' })
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json().request).toMatchObject({ status: 'returned', decisionNote: 'Use the accrual account', decidedById: U.ceo!.id })
    expect(await prisma.auditLog.count({ where: { action: 'approval.decide', entityId: id, tenantId: A } })).toBe(1)

    const edited = await call('fin', 'PATCH', `/accounting/journal-requests/${id}`, { description: 'Rent accrual (fixed)' })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().request).toMatchObject({ status: 'returned', description: 'Rent accrual (fixed)' })
    expect((await call('fin', 'POST', `/accounting/journal-requests/${id}/submit`, {})).json().request.status).toBe('submitted')

    const ok = await call('ceo', 'POST', `/accounting/journal-requests/${id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    const { request, entryId } = ok.json() as { request: { status: string; postedEntryId: string; decidedVia: string }; entryId: string }
    expect(request).toMatchObject({ status: 'posted', postedEntryId: entryId, decidedVia: 'role' })
    // Twice → 409, posted once.
    const again = await call('ceo', 'POST', `/accounting/journal-requests/${id}/approve`, {})
    expect([again.statusCode, code(again)]).toEqual([409, 'REQUEST_NOT_PENDING'])

    const viaRequest = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: { include: { account: true } } } })
    expect(viaRequest).toMatchObject({ tenantId: A, reference: `manual:${id}`, postedBy: U.ceo!.id })
    expect(await prisma.journalEntry.count({ where: { tenantId: A, reference: `manual:${id}` } })).toBe(1)

    // The direct post of the same body makes the same entry (all but its id / key).
    const direct = await call('ceo', 'POST', '/accounting/journal', {
      description: 'Rent accrual (fixed)', reference: 'SEP-RENT', entryDate: '2026-10-05T07:00:00.000Z', lines,
    }, A)
    expect(direct.statusCode, direct.body).toBe(201)
    const d = direct.json() as { id: string; tenantId: string; description: string; entryDate: string; lines: Array<{ account: { code: string }; type: string; amountCents: number; memo: string | null; conceptId: string | null }> }
    const shape = (ls: Array<{ account: { code: string }; type: string; amountCents: unknown; memo: string | null; conceptId: string | null }>) =>
      ls.map((l) => `${l.account.code}|${l.type}|${Number(l.amountCents)}|${l.memo ?? ''}|${l.conceptId ?? ''}`).sort()
    expect(viaRequest.description).toBe(d.description)
    expect(viaRequest.entryDate.toISOString()).toBe(new Date(d.entryDate).toISOString())
    expect(shape(viaRequest.lines)).toEqual(shape(d.lines))
    // Both raised the manual_journal exception in A.
    expect(await prisma.exceptionFlag.count({ where: { kind: 'manual_journal', entityId: entryId, tenantId: A } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'manual_journal', entityId: d.id, tenantId: A } })).toBe(1)

    // The CEO's reverse route undoes the request's entry.
    const rev = await call('ceo', 'POST', `/accounting/journal/${entryId}/reverse`, { reason: 'Posted to the wrong month' }, A)
    expect(rev.statusCode, rev.body).toBe(201)
    expect(rev.json()).toMatchObject({ tenantId: A, reference: `manual.reversal:${id}`, reverses: { id: entryId } })
    const net = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: A, reference: { in: [`manual:${id}`, `manual.reversal:${id}`] } } } })
    const sum = net.reduce((s, l) => s + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
    expect(sum).toBe(0)
    expect(net).toHaveLength(4)
  })

  it('a closed month → 422 PERIOD_LOCKED, nothing posted, the request stays submitted', async () => {
    const res = await draft('fin', { entryDate: '2026-08-20T07:00:00.000Z', submit: true })
    expect(res.statusCode, res.body).toBe(201)
    const id = res.json().request.id as string
    expect(res.json().request.status).toBe('submitted')
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: new Date('2026-08-31T18:59:59.999Z'), lockedBy: U.ceo!.id } })
    try {
      const refused = await call('ceo', 'POST', `/accounting/journal-requests/${id}/approve`, {})
      expect([refused.statusCode, code(refused)]).toEqual([422, 'PERIOD_LOCKED'])
      const row = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
      expect(row).toMatchObject({ status: 'submitted', decidedById: null, postedEntryId: null })
      expect(await prisma.journalEntry.count({ where: { reference: `manual:${id}` } })).toBe(0)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    // Withdrawn by its preparer; nobody else.
    expect((await call('fin2', 'POST', `/accounting/journal-requests/${id}/withdraw`, {})).statusCode).toBe(403)
    const w = await call('fin', 'POST', `/accounting/journal-requests/${id}/withdraw`, {})
    expect([w.statusCode, w.json().request.status]).toEqual([200, 'withdrawn'])
  })
})

describe('approvers', () => {
  it('a delegation grant for journal_request → 422 SECTION_NOT_YET_DELEGABLE (A22)', async () => {
    const res = await call('ceo', 'POST', '/approvals/delegations', {
      headOfficeId: HO, companyTenantId: A, section: 'finance', approvalTypes: ['journal_request'], delegateUserId: U.hodFin2!.id, note: 'month end',
    }, A)
    expect([res.statusCode, code(res)]).toEqual([422, 'SECTION_NOT_YET_DELEGABLE'])
  })

  it('once handed over: the preparer gets 403 SELF_APPROVAL_BLOCKED, another delegate posts it; kind reverse stays the CEO\'s', async () => {
    const enabled = R.DELEGATION_ENABLED as Record<string, boolean>
    enabled.journal_request = true // the owner says yes (the constant flips)
    try {
      for (const who of ['hodFin', 'hodFin2']) {
        await prisma.approvalDelegation.create({
          data: { tenantId: HO, companyTenantId: A, section: 'finance', approvalTypes: ['journal_request'], delegateUserId: U[who]!.id, grantedById: U.ceo!.id, note: 'test' },
        })
      }
      const res = await draft('hodFin', { submit: true })
      expect(res.statusCode, res.body).toBe(201)
      const r = res.json().request
      expect(r).toMatchObject({ tenantId: A, status: 'submitted', viaHeadOfficeId: HO })

      const self = await call('hodFin', 'POST', `/accounting/journal-requests/${r.id}/approve`, {})
      expect([self.statusCode, code(self)]).toEqual([403, 'SELF_APPROVAL_BLOCKED'])
      expect((await prisma.journalRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('submitted')

      const ok = await call('hodFin2', 'POST', `/accounting/journal-requests/${r.id}/approve`, {}, HO)
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json().request).toMatchObject({ status: 'posted', decidedVia: 'delegation', decidedById: U.hodFin2!.id })
      const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ok.json().entryId } })
      expect(entry.tenantId).toBe(A) // A19: the request's company, never the delegate's head office
      expect(await prisma.auditLog.count({ where: { action: 'approval.decide', entityId: r.id, tenantId: A } })).toBe(1)

      // Kind reverse: finance asks, the delegate is refused, the CEO posts it.
      const asked = await call('fin', 'POST', '/accounting/journal-requests', { kind: 'reverse', reverseEntryId: entry.id, reason: 'Duplicate of the rent accrual', submit: true })
      expect(asked.statusCode, asked.body).toBe(201)
      const rq = asked.json().request
      expect(rq).toMatchObject({ kind: 'reverse', status: 'submitted', reverseEntryId: entry.id, totalCents: 250_000 })
      const dup = await call('fin2', 'POST', '/accounting/journal-requests', { kind: 'reverse', reverseEntryId: entry.id, reason: 'Duplicate again' })
      expect([dup.statusCode, code(dup)]).toEqual([409, 'REVERSAL_ALREADY_REQUESTED'])
      const delegate = await call('hodFin2', 'POST', `/accounting/journal-requests/${rq.id}/approve`, {}, HO)
      expect(delegate.statusCode).toBe(403)
      const ceo = await call('ceo', 'POST', `/accounting/journal-requests/${rq.id}/approve`, {}, A)
      expect(ceo.statusCode, ceo.body).toBe(200)
      const reversal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ceo.json().entryId } })
      expect(reversal).toMatchObject({ tenantId: A, reference: `manual.reversal:${r.id}` })
      // Reversing it again is refused at prepare time.
      const twice = await call('fin', 'POST', '/accounting/journal-requests', { kind: 'reverse', reverseEntryId: entry.id, reason: 'Once more please' })
      expect([twice.statusCode, code(twice)]).toEqual([409, 'ALREADY_REVERSED'])
    } finally {
      enabled.journal_request = false
      await prisma.approvalDelegation.updateMany({ where: { tenantId: HO, revokedAt: null }, data: { revokedAt: new Date(), revokedById: U.ceo!.id, revokeReason: 'test over' } })
    }
  })

  it('a reverse request names only a manual entry of the same company', async () => {
    const bEntry = await call('ceo', 'POST', '/accounting/journal', {
      description: 'B entry', entryDate: '2026-10-05T07:00:00.000Z',
      lines: [
        { accountId: await acct(B, '6010'), type: 'debit', amountCents: 1000 },
        { accountId: await acct(B, '1020'), type: 'credit', amountCents: 1000 },
      ],
    }, B)
    expect(bEntry.statusCode, bEntry.body).toBe(201)
    const res = await call('fin', 'POST', '/accounting/journal-requests', { kind: 'reverse', reverseEntryId: bEntry.json().id, reason: 'Not ours to reverse' })
    expect(res.statusCode).toBe(404)
  })
})
