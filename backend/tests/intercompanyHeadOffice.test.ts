// Head-office pairs on the EXISTING inter-company engine (D1 §4.6 replaced by
// the owner's "reuse the inter-company transfer engine"; D3 delegation).
//
// Fixtures built directly: a head office HO linked (live) to C1 and C2, and
// an unlinked company B.
//
//   - an HO finance member who is NOT a member of C1 prepares a settlement and
//     a paired adjustment (a 'charge') for HO↔C1; both books post on approval;
//   - the CEO can approve;
//   - a Finance delegate scoped to C1 approves HO↔C1 but not HO↔C2, and never
//     an ordinary company↔company transfer;
//   - the preparer cannot approve (assertCanApprove and the claim);
//   - reverse is CEO only; a 'ho_recharge' transfer is reversed from its run;
//   - counters: the HO's recharge account (4220 income, HO-Q3) / the link's charges account → 422;
//   - unlinked B: its members get 404; HO↔B is never prepared;
//   - through the lens the HO member sees only HO↔C1, never C1↔C2.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { fmtPktDate } = await import('../src/modules/accounting/dates.js')
const { intercompanyRoutes } = await import('../src/modules/intercompany/routes.js')
const { pairBalances } = await import('../src/modules/intercompany/accounts.js')
const { postSystemTransferTx, SYSTEM_SOURCES } = await import('../src/modules/intercompany/service.js')

const P = `icho-${Date.now()}`
let app: FastifyInstance
let HO: string, C1: string, C2: string, B: string

interface Who { id: string; token: string }
let ceo: Who, hoAdmin: Who, hoFin: Who, deleg: Who, bFin: Who, c1Fin: Who

async function mkTenant(name: string, kind: 'company' | 'head_office' = 'company'): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name: `${P} ${name}`, slug: `${P}-${name.toLowerCase()}`, kind } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, role: 'admin' | 'finance', tenants: string[], active = tenants[0]!): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@icho.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: active, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role })) },
    },
  })
  return { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method, url: `/api/v1/accounting/intercompany${url}`,
    headers: { authorization: who.token, ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })

const daysAgo = (n: number) => fmtPktDate(new Date(Date.now() - n * 86_400_000))

async function entryOf(tenantId: string, ref: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference: ref },
    include: { lines: { include: { account: { select: { code: true, controlledBy: true } } } } },
  })
}

beforeAll(async () => {
  HO = await mkTenant('HO', 'head_office')
  C1 = await mkTenant('C1')
  C2 = await mkTenant('C2')
  B = await mkTenant('B')
  ceo = await mkUser('ceo', 'admin', [HO, C1, C2, B], HO)
  hoAdmin = await mkUser('hoadmin', 'admin', [HO])        // admin of HO only, not a company member
  hoFin = await mkUser('hofin', 'finance', [HO])          // HO finance, not a company member
  deleg = await mkUser('deleg', 'finance', [HO])          // HO finance, Finance delegate for C1 only
  bFin = await mkUser('bfin', 'finance', [B])
  c1Fin = await mkUser('c1fin', 'finance', [C1, C2], C1)   // finance of C1 + C2 (ordinary pair)
  for (const c of [C1, C2]) {
    await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: c, createdById: ceo.id, startedAt: new Date('2026-01-01') } })
  }
  await prisma.approvalDelegation.create({
    data: { tenantId: HO, companyTenantId: C1, section: 'finance', approvalTypes: ['intercompany_transfer'], delegateUserId: deleg.id, grantedById: ceo.id, note: 'test' },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(intercompanyRoutes, { prefix: '/accounting/intercompany' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

let adjId: string
let settleId: string
let c2SettleId: string

describe('an HO finance member prepares for HO↔C1', () => {
  it('ho_recharge is a system source', () => {
    expect([...SYSTEM_SOURCES]).toEqual(['fleet', 'cod', 'ho_recharge', 'asset_transfer'])
  })

  it('/companies lists the head office pairs it may prepare for', async () => {
    const r = await call(hoFin, 'GET', '/companies')
    expect(r.statusCode).toBe(200)
    expect(r.json().companies.map((c: { id: string }) => c.id)).toEqual([HO])
    expect(r.json().can).toEqual({ prepare: true, decide: false })
    const pairs = r.json().headOfficePairs
    expect(pairs).toHaveLength(1)
    expect(pairs[0].headOffice.id).toBe(HO)
    expect(pairs[0].companies.map((c: { id: string }) => c.id).sort()).toEqual([C1, C2].sort())
    expect((await call(bFin, 'GET', '/companies')).json().headOfficePairs).toEqual([])
  })

  it('refuses the head office recharge account and the link charges account as counters (A9)', async () => {
    const base = { kind: 'charge', debtorTenantId: C1, creditorTenantId: HO, amountCents: 10_000, entryDate: daysAgo(3), memo: 'HO paid C1 cost' }
    const r1 = await call(hoFin, 'POST', '/transfers', { ...base, debtorAccountCode: '6010', creditorAccountCode: '4220' })
    expect(r1.statusCode).toBe(422)
    expect(r1.json().error.code).toBe('COUNTER_ACCOUNT_INVALID')
    const charges = await prisma.account.create({ data: { tenantId: C1, code: '6200', name: `Head office charges — ${P} HO`, type: 'expense' } })
    await prisma.headOfficeLink.updateMany({ where: { tenantId: HO, companyTenantId: C1 }, data: { chargesAccountId: charges.id } })
    const r2 = await call(hoFin, 'POST', '/transfers', { ...base, debtorAccountCode: '6200', creditorAccountCode: '1020' })
    expect(r2.statusCode).toBe(422)
    expect(r2.json().error.code).toBe('COUNTER_ACCOUNT_INVALID')
    expect(await prisma.intercompanyTransfer.count({ where: { OR: [{ tenantId: HO }, { counterpartyTenantId: HO }] } })).toBe(0)
  })

  it('prepares a paired adjustment (increase: C1 owes the HO more)', async () => {
    const r = await call(hoFin, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: C1, creditorTenantId: HO, amountCents: 50_000, entryDate: daysAgo(3),
      memo: 'HO paid a cost wholly for C1', debtorAccountCode: '6010', creditorAccountCode: '1020',
    })
    expect(r.statusCode).toBe(201)
    adjId = r.json().id
    expect(r.json().status).toBe('submitted')
    expect(r.json().source).toBe('manual')
    expect(r.json().canApprove).toBe(false) // the preparer
    expect(await entryOf(HO, `ic.transfer:${adjId}`)).toBeNull()
  })

  it('a non-member preparing from a company that is not the head office is refused', async () => {
    // Active company is HO, but neither side is HO and they belong to neither company.
    const r = await call(hoFin, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: C1, creditorTenantId: C2, amountCents: 1_000, entryDate: daysAgo(1),
      memo: 'not mine', debtorAccountCode: '6010', creditorAccountCode: '1020',
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
  })

  it('the C1 delegate sees the transfer with canApprove and approves it: both books post', async () => {
    const list = await call(deleg, 'GET', '/transfers?status=submitted')
    expect(list.statusCode).toBe(200)
    const item = list.json().items.find((i: { id: string }) => i.id === adjId)
    expect(item.canApprove).toBe(true)
    const ok = await call(deleg, 'POST', `/transfers/${adjId}/approve`, { note: 'ok' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('posted')
    expect(ok.json().selfApproved).toBe(false)
    const inHo = await entryOf(HO, `ic.transfer:${adjId}`)
    const inC1 = await entryOf(C1, `ic.transfer:${adjId}`)
    expect(inHo && inC1).toBeTruthy()
    expect(inC1!.lines.find((l) => l.type === 'debit')!.account.code).toBe('6010')
    expect(inC1!.lines.find((l) => l.type === 'credit')!.account.controlledBy).toBe('intercompany')
    expect(inHo!.lines.find((l) => l.type === 'debit')!.account.controlledBy).toBe('intercompany')
    expect(inHo!.lines.find((l) => l.type === 'credit')!.account.code).toBe('1020')
    const bal = await pairBalances(prisma, C1, HO)
    expect(bal.aDueToB).toBe(50_000)
    expect(bal.bDueFromA).toBe(50_000)
    expect(bal.mismatchCents).toBe(0)
    // decidedVia in both companies' audit + the one approval.decide row.
    const audits = await prisma.auditLog.findMany({ where: { action: 'intercompany.transfer.approve', entityId: adjId } })
    expect(audits.map((a) => a.tenantId).sort()).toEqual([HO, C1].sort())
    expect((audits[0]!.metadata as { decidedVia?: string }).decidedVia).toBe('delegation')
    const decide = await prisma.auditLog.findFirst({ where: { action: 'approval.decide', entityId: adjId } })
    expect((decide!.metadata as { via?: string; type?: string }).via).toBe('delegation')
    expect((decide!.metadata as { type?: string }).type).toBe('intercompany_transfer')
  })

  it('prepares a settlement (C1 pays the HO); the CEO approves it; both books post', async () => {
    const r = await call(hoFin, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: C1, creditorTenantId: HO, amountCents: 20_000, entryDate: daysAgo(2),
      memo: 'C1 pays the head office', method: 'cash', bankReference: 'HO-CASH-1',
    })
    expect(r.statusCode).toBe(201)
    settleId = r.json().id
    const ok = await call(ceo, 'POST', `/transfers/${settleId}/approve`, {})
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('posted')
    const inHo = await entryOf(HO, `ic.transfer:${settleId}`)
    const inC1 = await entryOf(C1, `ic.transfer:${settleId}`)
    expect(inC1!.lines.find((l) => l.type === 'credit')!.account.code).toBe('1010')
    expect(inHo!.lines.find((l) => l.type === 'debit')!.account.code).toBe('1010')
    const bal = await pairBalances(prisma, C1, HO)
    expect(bal.aDueToB).toBe(30_000)
    expect(bal.bDueFromA).toBe(30_000)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'intercompany.transfer.approve', entityId: settleId } })
    expect((audit!.metadata as { decidedVia?: string }).decidedVia).toBe('role')
  })
})

describe('who may decide', () => {
  it('the C1 delegate cannot approve HO↔C2', async () => {
    const posted = await call(ceo, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: C2, creditorTenantId: HO, amountCents: 8_000, entryDate: daysAgo(3),
      memo: 'HO cost for C2', debtorAccountCode: '6010', creditorAccountCode: '1020', postNow: true,
    })
    expect(posted.statusCode).toBe(201)
    const r = await call(hoFin, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: C2, creditorTenantId: HO, amountCents: 1_000, entryDate: daysAgo(1),
      memo: 'C2 pays', method: 'cash', bankReference: 'HO-CASH-2',
    })
    expect(r.statusCode).toBe(201)
    c2SettleId = r.json().id
    const list = await call(deleg, 'GET', '/transfers?status=submitted')
    expect(list.json().items.find((i: { id: string }) => i.id === c2SettleId).canApprove).toBe(false)
    const no = await call(deleg, 'POST', `/transfers/${c2SettleId}/approve`, {})
    expect(no.statusCode).toBe(403)
    expect(no.json().error.code).toBe('APPROVAL_NOT_YOURS')
    const rej = await call(deleg, 'POST', `/transfers/${c2SettleId}/reject`, { note: 'nope' })
    expect(rej.statusCode).toBe(403)
    expect((await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: c2SettleId } })).status).toBe('submitted')
  })

  it('a delegate never approves an ordinary company↔company transfer', async () => {
    const posted = await call(c1Fin, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: C1, creditorTenantId: C2, amountCents: 5_000, entryDate: daysAgo(2),
      memo: 'Shared cost', debtorAccountCode: '6010', creditorAccountCode: '6990',
    })
    expect(posted.statusCode).toBe(201)
    const id = posted.json().id
    const no = await call(deleg, 'POST', `/transfers/${id}/approve`, {})
    expect([403, 404]).toContain(no.statusCode)
    expect((await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id } })).status).toBe('submitted')
    // ...and the CEO still can.
    expect((await call(ceo, 'POST', `/transfers/${id}/approve`, {})).statusCode).toBe(200)
  })

  it('the preparer cannot approve (even holding the delegation)', async () => {
    const r = await call(deleg, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: C1, creditorTenantId: HO, amountCents: 1_000, entryDate: daysAgo(1),
      memo: 'prepared by the delegate', method: 'cash', bankReference: 'HO-CASH-3',
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().canApprove).toBe(false)
    const no = await call(deleg, 'POST', `/transfers/${r.json().id}/approve`, {})
    expect(no.statusCode).toBe(403)
    expect(no.json().error.code).toBe('SELF_APPROVAL_BLOCKED')
    expect((await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: r.json().id } })).status).toBe('submitted')
    // The CEO approving their own transfer is still allowed (selfApproved).
    const own = await call(ceo, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: C1, creditorTenantId: HO, amountCents: 500, entryDate: daysAgo(1),
      memo: 'CEO own', method: 'cash', bankReference: 'HO-CASH-4',
    })
    const ok = await call(ceo, 'POST', `/transfers/${own.json().id}/approve`, {})
    expect(ok.statusCode).toBe(200)
    expect(ok.json().selfApproved).toBe(true)
  })

  it('reverse is CEO only; a head-office recharge is reversed from its run', async () => {
    const no = await call(deleg, 'POST', `/transfers/${settleId}/reverse`, { reason: 'wrong amount entered' })
    expect(no.statusCode).toBe(403)
    const no2 = await call(hoFin, 'POST', `/transfers/${settleId}/reverse`, { reason: 'wrong amount entered' })
    expect(no2.statusCode).toBe(403)
    const ok = await call(ceo, 'POST', `/transfers/${settleId}/reverse`, { reason: 'wrong amount entered' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('reversed')
    expect(await entryOf(HO, `ic.transfer.reversal:${settleId}`)).toBeTruthy()
    expect(await entryOf(C1, `ic.transfer.reversal:${settleId}`)).toBeTruthy()

    const sys = await prisma.$transaction((tx) => postSystemTransferTx(tx, {
      kind: 'charge', source: 'ho_recharge', sourceRef: `ho_recharge:test:${P}`, debtorTenantId: C1, creditorTenantId: HO,
      amountCents: 3_000, entryDate: new Date(Date.now() - 86_400_000), debtorAccountCode: '6200', creditorAccountCode: '4220',
      memo: 'Head office charge test', preparedById: 'system', period: null,
    }), { timeout: 30_000 })
    const view = await call(ceo, 'GET', `/transfers/${sys.transferId}`)
    expect(view.json().canReverse).toBe(false)
    const r = await call(ceo, 'POST', `/transfers/${sys.transferId}/reverse`, { reason: 'trying from here instead' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('REVERSE_FROM_SOURCE')
  })
})

describe('separation', () => {
  it('unlinked company B: its member gets 404; HO↔B is never prepared', async () => {
    expect((await call(bFin, 'GET', `/transfers/${adjId}`)).statusCode).toBe(404)
    expect((await call(bFin, 'POST', `/transfers/${c2SettleId}/approve`, {})).statusCode).toBe(404)
    expect((await call(bFin, 'GET', '/transfers')).json().items.some((i: { id: string }) => i.id === adjId)).toBe(false)
    const hoB = await call(hoFin, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: B, creditorTenantId: HO, amountCents: 1_000, entryDate: daysAgo(1),
      memo: 'not linked', debtorAccountCode: '6010', creditorAccountCode: '1020',
    })
    expect(hoB.statusCode).toBe(403)
    expect(hoB.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    // Even the CEO of both: a head office transfers only with a company it serves or served.
    const ceoB = await call(ceo, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: B, creditorTenantId: HO, amountCents: 1_000, entryDate: daysAgo(1),
      memo: 'not linked', debtorAccountCode: '6010', creditorAccountCode: '1020',
    })
    expect(ceoB.statusCode).toBe(422)
    expect(ceoB.json().error.code).toBe('HEAD_OFFICE_NOT_LINKED')
  })

  it('an HO member sees the HO pairs, and through the lens only HO↔C1 — never C1↔C2', async () => {
    const own = await call(hoFin, 'GET', '/transfers?limit=500')
    expect(own.statusCode).toBe(200)
    const ids = own.json().items.map((i: { tenantId: string; counterpartyTenantId: string }) => [i.tenantId, i.counterpartyTenantId].sort().join(':'))
    expect(ids.every((k: string) => k.includes(HO))).toBe(true)
    expect(own.json().items.some((i: { id: string }) => i.id === adjId)).toBe(true)

    const lens = await call(hoFin, 'GET', '/transfers?limit=500', undefined, { 'x-servd-active-tenant': C1 })
    expect(lens.statusCode).toBe(200)
    const items = lens.json().items as Array<{ tenantId: string; counterpartyTenantId: string }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => [i.tenantId, i.counterpartyTenantId].sort().join(':') === [HO, C1].sort().join(':'))).toBe(true)

    const bal = await call(hoFin, 'GET', '/balances', undefined, { 'x-servd-active-tenant': C1 })
    expect(bal.statusCode).toBe(200)
    const pairs = bal.json().pairs as Array<{ a: { id: string }; b: { id: string }; headOfficePair?: boolean; bDueFromA: number | null }>
    expect(pairs).toHaveLength(1)
    expect([pairs[0]!.a.id, pairs[0]!.b.id].sort()).toEqual([HO, C1].sort())
    expect(pairs[0]!.headOfficePair).toBe(true)
    expect(pairs[0]!.bDueFromA).not.toBeNull()

    const balHo = await call(hoFin, 'GET', '/balances')
    const hoPairs = balHo.json().pairs as Array<{ a: { id: string }; b: { id: string }; headOfficePair?: boolean }>
    expect(hoPairs.map((p) => [p.a.id, p.b.id].sort().join(':')).sort()).toEqual([[HO, C1].sort().join(':'), [HO, C2].sort().join(':')].sort())
    expect(hoPairs.every((p) => p.headOfficePair)).toBe(true)
  })
})

describe('postNow needs membership of both companies', () => {
  it('an admin who belongs to HO only cannot post HO↔C1 at once, but can submit it', async () => {
    const body = {
      kind: 'settlement', debtorTenantId: C1, creditorTenantId: HO, amountCents: 1_500, entryDate: daysAgo(1),
      memo: 'HO admin settle', method: 'cash', bankReference: 'HO-ADMIN-1',
    }
    const before = await prisma.intercompanyTransfer.count({ where: { tenantId: { in: [HO, C1] }, memo: 'HO admin settle' } })
    const no = await call(hoAdmin, 'POST', '/transfers', { ...body, postNow: true })
    expect(no.statusCode).toBe(403)
    expect(no.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    expect(await prisma.intercompanyTransfer.count({ where: { tenantId: { in: [HO, C1] }, memo: 'HO admin settle' } })).toBe(before)
    const ok = await call(hoAdmin, 'POST', '/transfers', body)
    expect(ok.statusCode).toBe(201)
    expect(ok.json().status).toBe('submitted')
    expect(await entryOf(C1, `ic.transfer:${ok.json().id}`)).toBeNull()
  })

  it('the CEO (member of both) still posts HO↔C1 at once', async () => {
    const r = await call(ceo, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: C1, creditorTenantId: HO, amountCents: 700, entryDate: daysAgo(1),
      memo: 'CEO settle', method: 'cash', bankReference: 'HO-CEO-1', postNow: true,
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().status).toBe('posted')
  })
})

describe('headOfficePair marks the pair, not the reason it is shown', () => {
  it('the CEO (member of both) sees HO↔C1 as a head-office pair and C1↔C2 as not', async () => {
    const r = await call(ceo, 'GET', '/balances', undefined, { 'x-servd-active-tenant': C1 })
    expect(r.statusCode).toBe(200)
    const pairs = r.json().pairs as Array<{ a: { id: string }; b: { id: string }; memberOfBoth: boolean; headOfficePair: boolean }>
    const find = (x: string, y: string) => pairs.find((p) => [p.a.id, p.b.id].sort().join(':') === [x, y].sort().join(':'))
    expect(find(HO, C1)).toMatchObject({ memberOfBoth: true, headOfficePair: true })
    expect(find(C1, C2)).toMatchObject({ memberOfBoth: true, headOfficePair: false })
  })
})
