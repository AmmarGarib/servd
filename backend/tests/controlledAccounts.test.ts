// Controlled accounts (Account.controlledBy, journal.ts) — the inter-company
// pair accounts can only move through inter-company transfers.
//
//   - a manual journal entry (route and engine) touching a 'Due from' account
//     is 422 INTERCOMPANY_ACCOUNT_CONTROLLED and posts nothing;
//   - an 'ic.transfer' posting (and its reversal) passes;
//   - another company's pair account is never reachable from A's chart.
// (Deactivating a controlled account through Configuration → Chart of
// accounts is refused by w4-integration's setup guard — tested there.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry, reverseJournalEntry } = await import('../src/modules/accounting/journal.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { ensurePairAccounts } = await import('../src/modules/intercompany/accounts.js')

const PREFIX = `ctl-${Date.now()}`
let app: FastifyInstance
let A: string, B: string
let token: string
let dueFromId: string
let codes: { aDueFrom: string; aDueTo: string; bDueFrom: string; bDueTo: string }

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Ctl A', slug: `${PREFIX}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: 'Ctl B', slug: `${PREFIX}-b` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  codes = await prisma.$transaction((tx) => ensurePairAccounts(tx, A, B))
  dueFromId = (await prisma.account.findFirstOrThrow({ where: { tenantId: A, code: codes.aDueFrom } })).id
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ceo`, email: `${PREFIX}.ceo@ctl.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: 'admin', tenantId: A, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: A } }, role: 'admin' }] },
    },
  })
  token = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('inter-company accounts are controlled', () => {
  it('a manual journal on a Due-from account is 422 INTERCOMPANY_ACCOUNT_CONTROLLED (route)', async () => {
    const cash = (await prisma.account.findFirstOrThrow({ where: { tenantId: A, code: '1010' } })).id
    const r = await app.inject({
      method: 'POST', url: '/accounting/journal', headers: { authorization: token },
      payload: {
        description: 'Move money to B by hand',
        lines: [
          { accountId: dueFromId, type: 'debit', amountCents: 5_000 },
          { accountId: cash, type: 'credit', amountCents: 5_000 },
        ],
      },
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('INTERCOMPANY_ACCOUNT_CONTROLLED')
    expect(await prisma.journalLine.count({ where: { accountId: dueFromId } })).toBe(0)
  })

  it('the engine refuses any non-ic source on it, including a fixed-asset style override', async () => {
    for (const sourceType of ['manual', 'bank.adjust', 'fixed_asset.depreciation']) {
      await expect(postJournalEntry({
        tenantId: A, sourceType, sourceId: 's1', description: 'x', controlledOverride: { reason: 'I really mean it, honestly' },
        lines: [
          { accountCode: codes.aDueTo, type: 'debit', amountCents: 100 },
          { accountCode: '1010', type: 'credit', amountCents: 100 },
        ],
      })).rejects.toMatchObject({ code: 'INTERCOMPANY_ACCOUNT_CONTROLLED' })
    }
  })

  it("an 'ic.transfer' posting passes, and so does its reversal", async () => {
    const res = await postJournalEntry({
      tenantId: A, sourceType: 'ic.transfer', sourceId: 'manual-test-1', description: 'inter-company',
      lines: [
        { accountCode: codes.aDueFrom, type: 'debit', amountCents: 1_000 },
        { accountCode: '6990', type: 'credit', amountCents: 1_000 },
      ],
    })
    expect(res.posted).toBe(true)
    const rev = await reverseJournalEntry(A, 'ic.transfer', 'manual-test-1', 'test')
    expect(rev.posted).toBe(true)
    const entry = await prisma.journalEntry.findFirst({ where: { tenantId: A, reference: 'ic.transfer.reversal:manual-test-1' } })
    expect(entry).toBeTruthy()
  })

  it("B's pair account never resolves in A's chart (the codes are per company)", async () => {
    const bDueFrom = await prisma.account.findFirstOrThrow({ where: { tenantId: B, code: codes.bDueFrom } })
    expect(bDueFrom.controlledBy).toBe('intercompany')
    expect(bDueFrom.counterpartyTenantId).toBe(A)
    const r = await app.inject({
      method: 'POST', url: '/accounting/journal', headers: { authorization: token },
      payload: {
        description: "Touch B's pair account from A",
        lines: [
          { accountId: bDueFrom.id, type: 'debit', amountCents: 5_000 },
          { accountId: dueFromId, type: 'credit', amountCents: 5_000 },
        ],
      },
    })
    expect(r.statusCode).toBe(422)
    expect(await prisma.journalLine.count({ where: { accountId: bDueFrom.id } })).toBe(0)
  })
})
