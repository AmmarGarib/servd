// Control-account tie-out and the legacy cross-company residue (H30) —
// modules/intercompany/legacy.ts.
//
// Company A's wallet ledger (2050) carries pre-split residue: a cross-company
// spend debited A's 2050 and a pre-split top-up never posted. After the split
// a real top-up posts properly, and a 700 drift appears. What this defends:
//   - the tie-out per company (2050 / 2060 / 2080);
//   - the write-off clears ONLY the difference measured at the wallet split
//     migration; the later drift stays a 'control_tieout' warning;
//   - dry run first, then post; a second post is 409; nothing to write off is
//     422; another company's CEO gets 404; only the CEO (admin) may do it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { parsePktEndOfDay } = await import('../src/modules/accounting/dates.js')
const { intercompanyRoutes } = await import('../src/modules/intercompany/routes.js')
const legacy = await import('../src/modules/intercompany/legacy.js')
const { intercompanyCloseChecks } = await import('../src/modules/intercompany/closeChecks.js')

const PREFIX = `icl-${Date.now()}`
let app: FastifyInstance
let A: string, B: string

interface Who { id: string; token: string }
let ceoA: Who, ceoB: Who, finA: Who

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `${PREFIX}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, role: 'admin' | 'finance', tenants: string[]): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${key}`, email: `${PREFIX}.${key}@icl.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0]!, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role })) },
    },
  })
  return { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/accounting/intercompany${url}`, headers: { authorization: who.token }, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function post(tenantId: string, ref: string, at: string, dr: string, cr: string, cents: number) {
  await postJournalEntry({
    tenantId, sourceType: 'test.legacy', sourceId: ref, description: ref, entryDate: new Date(at),
    lines: [{ accountCode: dr, type: 'debit', amountCents: cents }, { accountCode: cr, type: 'credit', amountCents: cents }],
  })
}

const WALLET_SPLIT = '2026-10-11T16:00:00.000Z'   // 20261011160000 (no _prisma_migrations in the test database)

beforeAll(async () => {
  A = await mkTenant('Legacy Alpha')
  B = await mkTenant('Legacy Bravo')
  ceoA = await mkUser('ceo-a', 'admin', [A])
  ceoB = await mkUser('ceo-b', 'admin', [B])
  finA = await mkUser('fin-a', 'finance', [A])

  const cu = await prisma.customer.create({ data: { name: `${PREFIX} customer`, phone: `92311${Date.now() % 10_000_000}` } })
  // A, before the split: a 20,000 top-up never posted; a cross-company spend debited A's 2050 by 5,000.
  await prisma.walletTransaction.create({ data: { tenantId: A, customerId: cu.id, type: 'topup', amountCents: 20_000, balanceAfter: 20_000, createdAt: new Date('2026-10-01T08:00:00Z') } })
  await post(A, 'spend-at-a', '2026-10-01T09:00:00Z', '2050', '4001', 5_000)
  // After the split: a 3,000 top-up posted properly, and a 700 drift with no wallet move.
  await prisma.walletTransaction.create({ data: { tenantId: A, customerId: cu.id, type: 'topup', amountCents: 3_000, balanceAfter: 23_000, createdAt: new Date('2026-10-12T10:00:00Z') } })
  await post(A, 'topup-after', '2026-10-12T10:00:00Z', '1010', '2050', 3_000)
  await post(A, 'drift-after', '2026-10-12T11:00:00Z', '2050', '1010', 700)
  await prisma.customerWallet.create({ data: { tenantId: A, customerId: cu.id, balanceCents: 23_000 } })
  // A tagged cross-company redemption (evidence only; A's loyalty ties out).
  const accA = await prisma.loyaltyAccount.create({ data: { tenantId: A, customerId: cu.id, pointsBalance: 0 } })
  await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: accA.id, type: 'redeem', pointsDelta: -200, description: 'Redeemed [cross-company redemption at Other Co]', createdAt: new Date('2026-10-02T08:00:00Z') } })

  // B: 1,000 points earned and accrued before the split — the books agree.
  const accB = await prisma.loyaltyAccount.create({ data: { tenantId: B, customerId: cu.id, pointsBalance: 1_000, lifetimePoints: 1_000 } })
  await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: accB.id, type: 'earn', pointsDelta: 1_000, createdAt: new Date('2026-10-05T08:00:00Z') } })
  await post(B, 'accrual-b', '2026-10-05T08:00:00Z', '6060', '2060', 10_000)

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

describe('the tie-out', () => {
  it('per company: A 2050 is off by the residue plus the drift; B ties out', async () => {
    const a = await legacy.controlTieOut(prisma, A, new Date())
    const w = a.rows.find((r) => r.code === '2050')!
    expect(w).toMatchObject({ ledgerCents: -2_700, subledgerCents: 23_000, differenceCents: -25_700 })
    expect(a.rows.find((r) => r.code === '2060')!.differenceCents).toBe(0)
    expect(a.rows.find((r) => r.code === '2080')!.differenceCents).toBe(0)
    expect(a.clean).toBe(false)
    const b = await legacy.controlTieOut(prisma, B, new Date())
    expect(b.rows.find((r) => r.code === '2060')).toMatchObject({ ledgerCents: 10_000, subledgerCents: 10_000, differenceCents: 0 })
    expect(b.clean).toBe(true)
  })

  it('the residue is measured at the wallet split migration', async () => {
    const d = await legacy.legacyDifference(prisma, A, '2050')
    expect(d).toMatchObject({ splitAt: WALLET_SPLIT, ledgerCents: -5_000, subledgerCents: 20_000, differenceCents: -25_000, writtenOff: null })
  })
})

describe('the write-off', () => {
  it('only the CEO; another company is 404; posting needs a reason', async () => {
    expect((await call(finA, 'POST', '/legacy-writeoff', { code: '2050', dryRun: true })).statusCode).toBe(403)
    const foreign = await call(ceoB, 'POST', '/legacy-writeoff', { code: '2050', dryRun: true, tenantId: A })
    expect(foreign.statusCode).toBe(404)
    const noReason = await call(ceoA, 'POST', '/legacy-writeoff', { code: '2050', dryRun: false })
    expect(noReason.statusCode).toBe(422)
    expect(noReason.json().error.code).toBe('REASON_REQUIRED')
  })

  it('dry run shows the split-date figure, the lines, the evidence and the drift that stays; nothing posts', async () => {
    const r = await call(ceoA, 'POST', '/legacy-writeoff', { code: '2050', dryRun: true })
    expect(r.statusCode).toBe(200)
    const p = r.json()
    expect(p.differenceCents).toBe(-25_000)
    expect(p.driftAfterSplitCents).toBe(-700)
    expect(p.lines).toEqual([
      expect.objectContaining({ accountCode: '6060', type: 'debit', amountCents: 25_000 }),
      expect.objectContaining({ accountCode: '2050', type: 'credit', amountCents: 25_000 }),
    ])
    expect(p.evidence.walletCreditsBeforeSplit).toEqual({ count: 1, cents: 20_000 })
    expect(p.evidence.crossCompanyRedemptions.count).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: A, reference: { startsWith: 'legacy.cross_company_writeoff:' } } })).toBe(0)
  })

  it('posts once: Dr 6060 / Cr 2050 for the split-date difference; the drift stays', async () => {
    const r = await call(ceoA, 'POST', '/legacy-writeoff', { code: '2050', dryRun: false, reason: 'Pre-launch cross-company wallet residue (H30)' })
    expect(r.statusCode).toBe(200)
    const e = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: A, reference: `legacy.cross_company_writeoff:${A}:2050` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(e.id).toBe(r.json().entryId)
    expect(e.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['2050', 'credit', 25_000], ['6060', 'debit', 25_000]])
    const audits = await prisma.auditLog.findMany({ where: { action: 'legacy.cross_company_writeoff', tenantId: A } })
    expect(audits).toHaveLength(1)

    const again = await call(ceoA, 'POST', '/legacy-writeoff', { code: '2050', dryRun: false, reason: 'Pre-launch cross-company wallet residue (H30)' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_WRITTEN_OFF')

    const t = await call(ceoA, 'GET', '/tie-out')
    const company = t.json().companies.find((c: { tenantId: string }) => c.tenantId === A)
    expect(company.tieOut.rows.find((r: { code: string }) => r.code === '2050').differenceCents).toBe(-700)
    expect(company.legacy.find((l: { code: string }) => l.code === '2050').writtenOff).toBeTruthy()
    expect(company.canWriteOff).toBe(true)
    // B's tie-out is not A's to see.
    expect((await call(ceoB, 'GET', '/tie-out')).json().companies.map((c: { tenantId: string }) => c.tenantId)).toEqual([B])
  })

  it('a company whose books agreed at the split has nothing to write off (422)', async () => {
    const r = await call(ceoB, 'POST', '/legacy-writeoff', { code: '2060', dryRun: false, reason: 'Nothing should happen here' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NOTHING_TO_WRITE_OFF')
  })

  it("the later drift stays the close checklist's control_tieout warning", async () => {
    const check = intercompanyCloseChecks.find((c) => c.key === 'control_tieout')!
    const p = await check.run({ db: prisma, tenantId: A, prevLock: null, newLock: parsePktEndOfDay('2026-10-12'), months: ['2026-10'], isYearEnd: false })
    expect(p).toMatchObject({ key: 'control_tieout', severity: 'warn', count: 1, cents: 700 })
    expect(await check.run({ db: prisma, tenantId: B, prevLock: null, newLock: parsePktEndOfDay('2026-10-12'), months: ['2026-10'], isYearEnd: false })).toBeNull()
  })
})
