// Inter-company transfers (H30) — modules/intercompany. Three companies: A and
// B (a pair), and an unrelated C.
//
//   - pair accounts are created once in BOTH charts, against the right
//     counterparty, in the reserved ranges, skipping a code an operator used;
//   - finance of A+B prepares a settlement, the CEO approves, both books post
//     under 'ic.transfer:<id>' and A.dueTo(B) == B.dueFrom(A);
//   - membership of one side → 403; active company neither party → 422;
//     C → 404 on get / approve / reverse and its list excludes A–B;
//   - balance limits (settlement, netting), a closed month in B → 422 naming
//     B with nothing in A, reversal in both books, approve twice → 409;
//   - postSystemTransferTx is idempotent on sourceRef; a COD transfer is not
//     reversed from here; the nightly pair check flags a one-sided entry.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { parsePktEndOfDay, fmtPktDate } = await import('../src/modules/accounting/dates.js')
const { intercompanyRoutes } = await import('../src/modules/intercompany/routes.js')
const { ensurePairAccounts, pairBalances } = await import('../src/modules/intercompany/accounts.js')
const { postSystemTransferTx, reverseSystemTransfer } = await import('../src/modules/intercompany/service.js')
const { flagPairMismatches } = await import('../src/workers/intercompanyFleet.js')

const PREFIX = `ic-${Date.now()}`
let app: FastifyInstance
let A: string, B: string, C: string
let conceptA: string, conceptB: string

interface Who { id: string; token: string }
let ceoAB: Who, finAB: Who, finA: Who, ceoC: Who, ceoABC_activeC: Who

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `${PREFIX}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, role: 'admin' | 'finance', tenants: string[], active = tenants[0]!): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${key}`, email: `${PREFIX}.${key}@ic.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: active, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role })) },
    },
  })
  return { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/accounting/intercompany${url}`, headers: { authorization: who.token }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const daysAgo = (n: number) => fmtPktDate(new Date(Date.now() - n * 86_400_000))

async function entryOf(tenantId: string, ref: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference: ref },
    include: { lines: { include: { account: { select: { code: true, controlledBy: true, counterpartyTenantId: true } } } } },
  })
}

beforeAll(async () => {
  A = await mkTenant('IC Alpha')
  B = await mkTenant('IC Bravo')
  C = await mkTenant('IC Charlie')
  conceptA = (await prisma.concept.create({ data: { name: 'Alpha brand', slug: `${PREFIX}-ca`, type: 'restaurant', tenantId: A } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Bravo brand', slug: `${PREFIX}-cb`, type: 'restaurant', tenantId: B } })).id
  ceoAB = await mkUser('ceo-ab', 'admin', [A, B])
  finAB = await mkUser('fin-ab', 'finance', [A, B])
  finA = await mkUser('fin-a', 'finance', [A])
  ceoC = await mkUser('ceo-c', 'admin', [C])
  ceoABC_activeC = await mkUser('ceo-abc', 'admin', [A, B, C], C)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(intercompanyRoutes, { prefix: '/accounting/intercompany' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('capabilities', () => {
  it('GET /companies lists the caller\'s companies and what they may do (no role list in the page)', async () => {
    const fin = await call(finAB, 'GET', '/companies')
    expect(fin.statusCode).toBe(200)
    expect(fin.json().companies.map((c: { id: string }) => c.id).sort()).toEqual([A, B].sort())
    expect(fin.json().can).toEqual({ prepare: true, decide: false })
    expect((await call(ceoAB, 'GET', '/companies')).json().can).toEqual({ prepare: true, decide: true })
    expect((await call(ceoC, 'GET', '/companies')).json().companies.map((c: { id: string }) => c.id)).toEqual([C])
  })
})

describe('pair accounts', () => {
  it('are created once in both charts, against the right counterparty, skipping an operator code', async () => {
    // The operator already used 1450 in A for something else.
    await prisma.account.create({ data: { tenantId: A, code: '1450', name: 'Operator deposit', type: 'asset' } })
    const first = await prisma.$transaction((tx) => ensurePairAccounts(tx, A, B))
    expect(first).toEqual({ aDueFrom: '1451', aDueTo: '2150', bDueFrom: '1450', bDueTo: '2150' })
    const again = await prisma.$transaction((tx) => ensurePairAccounts(tx, B, A))
    expect(again).toEqual({ aDueFrom: '1450', aDueTo: '2150', bDueFrom: '1451', bDueTo: '2150' })
    const inA = await prisma.account.findMany({ where: { tenantId: A, controlledBy: 'intercompany' } })
    expect(inA).toHaveLength(2)
    expect(inA.every((a) => a.counterpartyTenantId === B)).toBe(true)
    expect(inA.find((a) => a.type === 'asset')?.name).toBe('Due from IC Bravo')
    expect(inA.find((a) => a.type === 'liability')?.name).toBe('Due to IC Bravo')
    const inB = await prisma.account.findMany({ where: { tenantId: B, controlledBy: 'intercompany' } })
    expect(inB).toHaveLength(2)
    expect(inB.every((a) => a.counterpartyTenantId === A)).toBe(true)
    expect(inB[0]!.description).toContain('Confirm with your CA')
  })
})

let chargeId: string
let settlementId: string

describe('transfers between A and B', () => {
  it('the CEO of both posts a charge at once: both books under ic.transfer:<id>', async () => {
    const r = await call(ceoAB, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: A, creditorTenantId: B, amountCents: 100_000, entryDate: daysAgo(3),
      memo: 'Shared office rent September', debtorAccountCode: '6010', creditorAccountCode: '6990',
      conceptSplit: [{ conceptId: conceptA, cents: 100_000 }], postNow: true,
    })
    expect(r.statusCode).toBe(201)
    const t = r.json()
    chargeId = t.id
    expect(t.status).toBe('posted')
    expect(t.selfApproved).toBe(true)
    const inA = await entryOf(A, `ic.transfer:${chargeId}`)
    const inB = await entryOf(B, `ic.transfer:${chargeId}`)
    expect(inA && inB).toBeTruthy()
    const drA = inA!.lines.find((l) => l.type === 'debit')!
    expect(drA.account.code).toBe('6010')
    expect(drA.conceptId).toBe(conceptA)
    expect(inA!.lines.find((l) => l.type === 'credit')!.account.controlledBy).toBe('intercompany')
    // No brand of A on B's lines.
    expect(inB!.lines.every((l) => l.conceptId === null)).toBe(true)
    expect(inB!.lines.find((l) => l.type === 'credit')!.account.code).toBe('6990')
    const bal = await pairBalances(prisma, A, B)
    expect(bal.aDueToB).toBe(100_000)
    expect(bal.bDueFromA).toBe(100_000)
    expect(bal.mismatchCents).toBe(0)
  })

  it('finance of both submits a settlement, the CEO approves, A.dueTo(B) == B.dueFrom(A)', async () => {
    const r = await call(finAB, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: A, creditorTenantId: B, amountCents: 40_000, entryDate: daysAgo(2),
      memo: 'September settlement', method: 'bank', bankReference: 'IBFT-001',
    })
    expect(r.statusCode).toBe(201)
    settlementId = r.json().id
    expect(r.json().status).toBe('submitted')
    expect(r.json().canApprove).toBe(false)
    expect(await entryOf(A, `ic.transfer:${settlementId}`)).toBeNull()

    // The inbox reads the queue as the CEO.
    const queue = await call(ceoAB, 'GET', '/transfers?status=submitted&limit=200')
    expect(queue.statusCode).toBe(200)
    const item = queue.json().items.find((i: { id: string }) => i.id === settlementId)
    expect(item.canApprove).toBe(true)

    const ok = await call(ceoAB, 'POST', `/transfers/${settlementId}/approve`, {})
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('posted')
    const inA = await entryOf(A, `ic.transfer:${settlementId}`)
    const inB = await entryOf(B, `ic.transfer:${settlementId}`)
    expect(inA!.lines.find((l) => l.type === 'credit')!.account.code).toBe('1020')
    expect(inB!.lines.find((l) => l.type === 'debit')!.account.code).toBe('1020')
    const bal = await pairBalances(prisma, A, B)
    expect(bal.aDueToB).toBe(60_000)
    expect(bal.bDueFromA).toBe(60_000)

    // Audited in BOTH companies.
    const audits = await prisma.auditLog.findMany({ where: { action: 'intercompany.transfer.approve', entityId: settlementId } })
    expect(audits.map((a) => a.tenantId).sort()).toEqual([A, B].sort())
  })

  it('approving twice is 409 NOT_SUBMITTED', async () => {
    const r = await call(ceoAB, 'POST', `/transfers/${settlementId}/approve`, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NOT_SUBMITTED')
  })

  it('finance of A only is 403; an active company that is neither side is 422', async () => {
    const one = await call(finA, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: A, creditorTenantId: B, amountCents: 1_000, entryDate: daysAgo(1), memo: 'grab', method: 'cash',
    })
    expect(one.statusCode).toBe(403)
    expect(one.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    const other = await call(ceoABC_activeC, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: A, creditorTenantId: B, amountCents: 1_000, entryDate: daysAgo(1), memo: 'from C', method: 'cash',
    })
    expect(other.statusCode).toBe(422)
    expect(other.json().error.code).toBe('ACTIVE_COMPANY_NOT_A_PARTY')
  })

  it('C gets 404 on A–B transfers and its list excludes them', async () => {
    expect((await call(ceoC, 'GET', `/transfers/${settlementId}`)).statusCode).toBe(404)
    expect((await call(ceoC, 'POST', `/transfers/${settlementId}/approve`, {})).statusCode).toBe(404)
    expect((await call(ceoC, 'POST', `/transfers/${chargeId}/reverse`, { reason: 'not mine to reverse' })).statusCode).toBe(404)
    const list = await call(ceoC, 'GET', '/transfers')
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toHaveLength(0)
    const bal = await call(ceoC, 'GET', '/balances')
    expect(bal.json().pairs).toHaveLength(0)
  })

  it('a brand of the other company on the charge is 422; a controlled account is 422', async () => {
    const r = await call(ceoAB, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: A, creditorTenantId: B, amountCents: 5_000, entryDate: daysAgo(1),
      memo: 'wrong brand', debtorAccountCode: '6010', creditorAccountCode: '6990', conceptSplit: [{ conceptId: conceptB, cents: 5_000 }],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('CONCEPT_NOT_IN_DEBTOR')
    const c = await call(ceoAB, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: A, creditorTenantId: B, amountCents: 5_000, entryDate: daysAgo(1),
      memo: 'onto a pair account', debtorAccountCode: '1451', creditorAccountCode: '6990',
    })
    expect(c.statusCode).toBe(422)
    expect(c.json().error.code).toBe('ACCOUNT_CONTROLLED')
  })

  it('a settlement over what is owed is 422; netting is capped by the smaller direction', async () => {
    const over = await call(finAB, 'POST', '/transfers', {
      kind: 'settlement', debtorTenantId: A, creditorTenantId: B, amountCents: 60_001, entryDate: daysAgo(1), memo: 'too much', method: 'cash',
    })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('SETTLEMENT_OVER_BALANCE')

    // B is charged 30,000 by A: now A owes B 60,000 and B owes A 30,000.
    const back = await call(ceoAB, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: B, creditorTenantId: A, amountCents: 30_000, entryDate: daysAgo(1),
      memo: 'Kitchen staff lent to B', debtorAccountCode: '6030', creditorAccountCode: '6990', postNow: true,
    })
    expect(back.statusCode).toBe(201)
    const tooMuch = await call(ceoAB, 'POST', '/transfers', {
      kind: 'netting', debtorTenantId: A, creditorTenantId: B, amountCents: 30_001, entryDate: daysAgo(1), memo: 'net it',
    })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json().error.code).toBe('NETTING_OVER_BALANCE')
    const net = await call(ceoAB, 'POST', '/transfers', {
      kind: 'netting', debtorTenantId: A, creditorTenantId: B, amountCents: 30_000, entryDate: daysAgo(1), memo: 'net it', postNow: true,
    })
    expect(net.statusCode).toBe(201)
    const bal = await pairBalances(prisma, A, B)
    expect(bal).toMatchObject({ aDueToB: 30_000, aDueFromB: 0, bDueFromA: 30_000, bDueToA: 0, mismatchCents: 0, netOwedByA: 30_000 })
  })

  it("B's closed month: 422 naming B, and nothing in A (submit and approve)", async () => {
    const lockDay = daysAgo(8)
    const lock = await prisma.periodLock.create({ data: { tenantId: B, lockedThrough: parsePktEndOfDay(lockDay), lockedBy: ceoAB.id } })
    try {
      const r = await call(finAB, 'POST', '/transfers', {
        kind: 'charge', debtorTenantId: A, creditorTenantId: B, amountCents: 7_000, entryDate: daysAgo(9),
        memo: 'into a closed month', debtorAccountCode: '6010', creditorAccountCode: '6990',
      })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
      expect(r.json().error.message).toContain('IC Bravo')
      expect(await prisma.intercompanyTransfer.count({ where: { memo: 'into a closed month' } })).toBe(0)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }

    // Submitted while open, then B closes the month before the CEO approves.
    const s = await call(finAB, 'POST', '/transfers', {
      kind: 'charge', debtorTenantId: A, creditorTenantId: B, amountCents: 7_000, entryDate: daysAgo(9),
      memo: 'closed before approval', debtorAccountCode: '6010', creditorAccountCode: '6990',
    })
    expect(s.statusCode).toBe(201)
    const id = s.json().id
    const lock2 = await prisma.periodLock.create({ data: { tenantId: B, lockedThrough: parsePktEndOfDay(lockDay), lockedBy: ceoAB.id } })
    try {
      const r = await call(ceoAB, 'POST', `/transfers/${id}/approve`, {})
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
      expect(r.json().error.message).toContain('IC Bravo')
      expect((await prisma.intercompanyTransfer.findUnique({ where: { id } }))!.status).toBe('submitted')
      expect(await entryOf(A, `ic.transfer:${id}`)).toBeNull()
      expect(await entryOf(B, `ic.transfer:${id}`)).toBeNull()
    } finally {
      await prisma.periodLock.delete({ where: { id: lock2.id } })
    }
    const rej = await call(ceoAB, 'POST', `/transfers/${id}/reject`, { note: 'wrong month' })
    expect(rej.statusCode).toBe(200)
    expect(rej.json().status).toBe('rejected')
  })

  it('the CEO reverses a transfer in both books; reversing again is 409', async () => {
    const r = await call(ceoAB, 'POST', `/transfers/${settlementId}/reverse`, { reason: 'paid from the wrong bank' })
    expect(r.statusCode).toBe(200)
    expect(r.json().status).toBe('reversed')
    expect(await entryOf(A, `ic.transfer.reversal:${settlementId}`)).toBeTruthy()
    expect(await entryOf(B, `ic.transfer.reversal:${settlementId}`)).toBeTruthy()
    const bal = await pairBalances(prisma, A, B)
    expect(bal.aDueToB).toBe(70_000)
    expect(bal.bDueFromA).toBe(70_000)
    const again = await call(ceoAB, 'POST', `/transfers/${settlementId}/reverse`, { reason: 'paid from the wrong bank' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('NOT_POSTED')
    // Finance never reverses.
    expect((await call(finAB, 'POST', `/transfers/${chargeId}/reverse`, { reason: 'finance should not' })).statusCode).toBe(403)
  })

  it('balances: a member of both sees both books; finance of A sees A only', async () => {
    const both = await call(ceoAB, 'GET', '/balances')
    expect(both.statusCode).toBe(200)
    const p = both.json().pairs[0]
    expect(p.memberOfBoth).toBe(true)
    expect(p.aDueToB).toBe(70_000)
    expect(p.bDueFromA).toBe(70_000)
    const one = await call(finA, 'GET', '/balances')
    const q = one.json().pairs[0]
    expect(q.memberOfBoth).toBe(false)
    expect(q.bDueFromA).toBeNull()
    expect(q.aDueToB).toBe(70_000)
  })
})

describe('system transfers (the COD / fleet seam)', () => {
  it('postSystemTransferTx is idempotent on sourceRef; reverseSystemTransfer frees it', async () => {
    const input = {
      kind: 'charge' as const, source: 'cod' as const, sourceRef: 'cod:payment-1',
      debtorTenantId: B, creditorTenantId: A, amountCents: 12_500, entryDate: new Date(),
      debtorAccountCode: '1351', creditorAccountCode: '1010', memo: 'Fleet rider kept COD of order ABCD1234', preparedById: finAB.id,
    }
    const one = await prisma.$transaction((tx) => postSystemTransferTx(tx, input))
    expect(one.alreadyPosted).toBe(false)
    const two = await prisma.$transaction((tx) => postSystemTransferTx(tx, input))
    expect(two).toMatchObject({ transferId: one.transferId, alreadyPosted: true, debtorEntryId: one.debtorEntryId })
    expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: 'cod:payment-1' } })).toBe(1)
    const inB = await entryOf(B, `ic.transfer:${one.transferId}`)
    expect(inB!.lines.find((l) => l.type === 'debit')!.account.code).toBe('1351')
    const inA = await entryOf(A, `ic.transfer:${one.transferId}`)
    expect(inA!.lines.find((l) => l.type === 'credit')!.account.code).toBe('1010')

    // Not reversed from the inter-company page: the COD module clears it.
    const viaRoute = await call(ceoAB, 'POST', `/transfers/${one.transferId}/reverse`, { reason: 'rider paid it in' })
    expect(viaRoute.statusCode).toBe(409)
    expect(viaRoute.json().error.code).toBe('REVERSE_FROM_SOURCE')

    await reverseSystemTransfer(one.transferId, 'Rider paid the cash in')
    await reverseSystemTransfer(one.transferId, 'Rider paid the cash in') // idempotent
    const row = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: one.transferId } })
    expect(row.status).toBe('reversed')
    expect(row.sourceRef).toBe(`cod:payment-1#reversed:${one.transferId}`)
    expect(await entryOf(A, `ic.transfer.reversal:${one.transferId}`)).toBeTruthy()
    expect(await entryOf(B, `ic.transfer.reversal:${one.transferId}`)).toBeTruthy()
  })

  it('a system transfer into a closed month is refused (PERIOD_LOCKED) and leaves nothing', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: parsePktEndOfDay(daysAgo(4)), lockedBy: ceoAB.id } })
    try {
      await expect(prisma.$transaction((tx) => postSystemTransferTx(tx, {
        kind: 'charge', source: 'cod', sourceRef: 'cod:payment-2', debtorTenantId: B, creditorTenantId: A, amountCents: 1_000,
        entryDate: parsePktEndOfDay(daysAgo(5)), debtorAccountCode: '1351', creditorAccountCode: '1010', memo: 'late', preparedById: 'system',
      }))).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
      expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: 'cod:payment-2' } })).toBe(0)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})

describe('the nightly pair check', () => {
  it('flags a one-sided inter-company entry in both companies, once', async () => {
    // An 'ic.*' entry posted in A only (a broken path): the books disagree.
    await postJournalEntry({
      tenantId: A, sourceType: 'ic.test_one_sided', sourceId: 'x1', description: 'one-sided', entryDate: new Date(),
      lines: [
        { accountCode: '2150', type: 'debit', amountCents: 2_500 },
        { accountCode: '1010', type: 'credit', amountCents: 2_500 },
      ],
    })
    const bal = await pairBalances(prisma, A, B)
    expect(bal.mismatchCents).toBe(2_500)
    expect(await flagPairMismatches()).toBe(2)
    expect(await flagPairMismatches()).toBe(0)
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'intercompany_mismatch' } })
    expect(flags.map((f) => f.tenantId).sort()).toEqual([A, B].sort())
    const r = await call(ceoAB, 'GET', '/balances')
    expect(r.json().pairs[0].mismatchCents).toBe(2_500)
  })
})
