// Chart-of-accounts guards (finance wave B): PATCH /setup/chart-of-accounts/:id
// refuses to switch off an account the books need, and renaming stays free.
//
//   - a REQUIRED code (2210 Due to Garibsons)          → 422 ACCOUNT_IN_USE
//   - a controlled account (an inter-company Due-from)  → 422 ACCOUNT_CONTROLLED
//   - the cost / accumulated code of an ACTIVE fixed-asset class (1510, and an
//     operator's own code a class points at)            → 422 ACCOUNT_IN_USE
//     (switch the class off and an ordinary code can go)
//   - an ordinary account switches off and on; any of them can be renamed
//   - another company's account is 404; POST never sets controlledBy
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { setupRoutes } from '../src/modules/setup/routes.js'

const P = `scg${Date.now()}`
let app: FastifyInstance
let tenantA = ''
let tenantB = ''
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@scg.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId: tenants[0]!,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

const accountId = async (tenantId: string, code: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId, code } })).id
const off = (who: string, id: string) => call(who, 'PATCH', `/setup/chart-of-accounts/${id}`, { isActive: false })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Chart A', slug: `${P}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Chart B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  await mkUser('ceoA', 'admin', [tenantA])
  await mkUser('ceoB', 'admin', [tenantB])

  // The register's kitchen-equipment class, active, on 1510 / 1591.
  await prisma.fixedAssetClass.create({
    data: { tenantId: tenantA, key: 'kitchen_equipment', label: 'Kitchen equipment', costAccountCode: '1510', accumAccountCode: '1591', defaultLifeMonths: 60 },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  // Controlled accounts must lose controlledBy before their company could go (accounts_controlled_company_chk).
  await prisma.account.updateMany({ where: { tenantId: { in: [tenantA, tenantB] }, controlledBy: 'intercompany' }, data: { controlledBy: null, counterpartyTenantId: null } })
  await app?.close()
})

describe('PATCH /setup/chart-of-accounts/:id — switching off', () => {
  it('an account still holding a balance → 422 ACCOUNT_HAS_BALANCE; once cleared to zero it switches off', async () => {
    const acc = await prisma.account.create({ data: { tenantId: tenantA, code: '9471', name: 'Garibsons Pvt Ltd (old)', type: 'liability' } })
    const other = await accountId(tenantA, '2210')
    const post = (debitId: string, creditId: string, ref: string) => prisma.journalEntry.create({
      data: {
        tenantId: tenantA, reference: `${P}:${ref}`, description: ref, entryDate: new Date(), postedBy: 'test',
        lines: { create: [{ accountId: debitId, type: 'debit', amountCents: 20_000_000 }, { accountId: creditId, type: 'credit', amountCents: 20_000_000 }] },
      },
    })
    await post(other, acc.id, 'in')
    const res = await off('ceoA', acc.id)
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_HAS_BALANCE')
    expect(res.json().error.message).toContain('200,000.00')
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).isActive).toBe(true)
    await post(acc.id, other, 'out')
    expect((await off('ceoA', acc.id)).statusCode).toBe(200)
  })

  it('a REQUIRED code (2210 Due to Garibsons) → 422 ACCOUNT_IN_USE; renaming it works', async () => {
    const id = await accountId(tenantA, '2210')
    const res = await off('ceoA', id)
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_IN_USE')
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).isActive).toBe(true)
    const renamed = await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${id}`, { name: 'Due to Garibsons (cashier)' })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toBe('Due to Garibsons (cashier)')
  })

  it('a controlled inter-company Due-from → 422 ACCOUNT_CONTROLLED; renaming it works', async () => {
    const due = await prisma.account.create({
      data: { tenantId: tenantA, code: '1450', name: 'Due from Chart B', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: tenantB },
    })
    const res = await off('ceoA', due.id)
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_CONTROLLED')
    expect((await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${due.id}`, { description: 'Group recharges' })).statusCode).toBe(200)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: due.id } })).isActive).toBe(true)
  })

  it("1510 while its class is active → 422 (the class's cost account)", async () => {
    const res = await off('ceoA', await accountId(tenantA, '1510'))
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_IN_USE')
    expect(res.json().error.message).toMatch(/Kitchen equipment/)
  })

  it("an operator's own code a class points at → 422 while the class is active; switch the class off and it can go", async () => {
    const own = await prisma.account.create({ data: { tenantId: tenantA, code: '1790', name: 'Other plant', type: 'asset' } })
    const cls = await prisma.fixedAssetClass.create({
      data: { tenantId: tenantA, key: 'other_plant', label: 'Other plant', costAccountCode: '1790', accumAccountCode: '1599', defaultLifeMonths: 84 },
    })
    const refused = await off('ceoA', own.id)
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('ACCOUNT_IN_USE')
    await prisma.fixedAssetClass.update({ where: { id: cls.id }, data: { isActive: false } })
    expect((await off('ceoA', own.id)).statusCode).toBe(200)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: own.id } })).isActive).toBe(false)
  })

  it('codes servd posts to that are not on the required list → 422: SRB output 2032, SRB input 1322, bad debts 6160, loyalty 7020 (final gate)', async () => {
    for (const code of ['2032', '1322', '6160', '7020']) {
      const id = await accountId(tenantA, code)
      const res = await off('ceoA', id)
      expect(res.statusCode, `${code} ${res.body}`).toBe(422)
      expect(res.json().error.code).toBe('ACCOUNT_IN_USE')
      expect((await prisma.account.findUniqueOrThrow({ where: { id } })).isActive).toBe(true)
    }
  })

  it("a live linked bank's chart code → 422; once the bank is switched off it can go (final gate)", async () => {
    const own = await call('ceoA', 'POST', '/setup/chart-of-accounts', { code: '1021', name: 'Meezan current', type: 'asset' })
    expect(own.statusCode, own.body).toBe(201)
    const bank = await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan', accountCode: '1021' } })
    const refused = await off('ceoA', own.json().id)
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().error.code).toBe('ACCOUNT_IN_USE')
    expect(refused.json().error.message).toMatch(/Meezan/)
    await prisma.bankAccount.update({ where: { id: bank.id }, data: { isActive: false } })
    expect((await off('ceoA', own.json().id)).statusCode).toBe(200)
  })

  it("a live brand's sales account → 422 (final gate)", async () => {
    // 'bukhari' books its sales to 4007 (CONCEPT_REVENUE_CODE); no other test uses the slug.
    const brand = await prisma.concept.create({ data: { name: 'Chart Bukhari', slug: 'bukhari', type: 'restaurant', tenantId: tenantA } })
    const id = await accountId(tenantA, '4007')
    const res = await off('ceoA', id)
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.message).toMatch(/sales account of the brand/)
    await prisma.concept.update({ where: { id: brand.id }, data: { deletedAt: new Date(), slug: `bukhari-gone-${P}` } })
    expect((await off('ceoA', id)).statusCode).toBe(200)
  })

  it('an ordinary account switches off and back on', async () => {
    const created = await call('ceoA', 'POST', '/setup/chart-of-accounts', { code: '6310', name: 'Marketing software', type: 'expense' })
    expect(created.statusCode).toBe(201)
    expect((await off('ceoA', created.json().id)).statusCode).toBe(200)
    expect((await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${created.json().id}`, { isActive: true })).statusCode).toBe(200)
  })

  it("another company's account is 404 — nothing changes", async () => {
    const idB = await accountId(tenantB, '4001')
    expect((await off('ceoA', idB)).statusCode).toBe(404)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: idB } })).isActive).toBe(true)
  })

  it('POST never sets controlledBy (a body field is ignored)', async () => {
    const res = await call('ceoA', 'POST', '/setup/chart-of-accounts', {
      code: '1096', name: 'Sneaky due-from', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: tenantB,
    })
    expect(res.statusCode).toBe(201)
    const row = await prisma.account.findUniqueOrThrow({ where: { id: res.json().id } })
    expect(row.controlledBy).toBeNull()
    expect(row.counterpartyTenantId).toBeNull()
    expect(row.tenantId).toBe(tenantA)
  })
})

// Owner, 2026-10-16: "Give Finance access to create / edit new account,
// deletion rights remains with CEO". Finance (with the accounting module)
// adds and renames accounts in its own company; switching one off or on stays
// the CEO's (403 ACCOUNT_SWITCH_CEO_ONLY); other roles are refused.
describe('finance adds and edits accounts; switching off stays with the CEO', () => {
  beforeAll(async () => {
    await mkUser('finA', 'finance', [tenantA])
    await mkUser('finB', 'finance', [tenantB])
    await mkUser('mgmtA', 'management', [tenantA])
    await mkUser('cashA', 'cashier', [tenantA])
    await mkUser('finNoMod', 'finance', [tenantA])
    await prisma.user.update({ where: { id: users['finNoMod']!.id }, data: { moduleDeny: ['accounting'] } })
  })

  it("finance creates in its own company (binds to it) and renames; another company's account is 404", async () => {
    const c = await call('finA', 'POST', '/setup/chart-of-accounts', { code: '9272', name: 'Garibsons Pvt Ltd', type: 'liability', description: 'Capital account' })
    expect(c.statusCode, c.body).toBe(201)
    expect(c.json().tenantId).toBe(tenantA)
    const id = c.json().id as string
    const r = await call('finA', 'PATCH', `/setup/chart-of-accounts/${id}`, { name: 'Garibsons (Pvt) Ltd', description: 'Project financing' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().name).toBe('Garibsons (Pvt) Ltd')
    expect((await call('finB', 'PATCH', `/setup/chart-of-accounts/${id}`, { name: 'x' })).statusCode).toBe(404)
    const dup = await call('finA', 'POST', '/setup/chart-of-accounts', { code: '9272', name: 'Again', type: 'liability' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('ACCOUNT_CODE_TAKEN')
    // The same code in company B is B's own account.
    expect((await call('finB', 'POST', '/setup/chart-of-accounts', { code: '9272', name: 'B account', type: 'liability' })).json().tenantId).toBe(tenantB)
  })

  it('finance switches an account off and back on (owner, 2026-10-16); the books\' guards still apply', async () => {
    const id = (await call('finA', 'POST', '/setup/chart-of-accounts', { code: '9273', name: 'To pause', type: 'expense' })).json().id as string
    expect((await off('finA', id)).statusCode).toBe(200)
    expect((await call('finA', 'PATCH', `/setup/chart-of-accounts/${id}`, { isActive: true })).statusCode).toBe(200)
    const req = await off('finA', await accountId(tenantA, '2210'))
    expect(req.statusCode).toBe(422)
    expect(req.json().error.code).toBe('ACCOUNT_IN_USE')
  })

  it('other roles, and finance without the accounting module, are refused', async () => {
    for (const who of ['mgmtA', 'cashA', 'finNoMod']) {
      const r = await call(who, 'POST', '/setup/chart-of-accounts', { code: `9${who.length}99`, name: 'No', type: 'expense' })
      expect(r.statusCode, who).toBe(403)
    }
  })
})

// Finance audit 2026-10-16 (item 40): the ranges a module owns are never
// created by hand — CEO and finance alike; nothing is written. Two companies:
// the refusal is the same in each; the code just outside binds to the caller's.
describe('module-owned account ranges are never created by hand', () => {
  it('a code in a reserved range is refused 422 ACCOUNT_CODE_RESERVED', async () => {
    for (const [who, tid, code] of [
      ['ceoA', tenantA, '1451'], ['finA', tenantA, '1555'], ['finA', tenantA, '2012'], ['ceoA', tenantA, '2160'],
      ['finA', tenantA, '6210'], ['finA', tenantA, '6995'], ['finA', tenantA, '1555.01'], ['finB', tenantB, '1420'],
    ] as const) {
      const before = await prisma.account.count({ where: { tenantId: tid, code } })
      const res = await call(who, 'POST', '/setup/chart-of-accounts', { code, name: 'Hand made', type: 'asset' })
      expect(res.statusCode, `${who} ${code}`).toBe(422)
      expect(res.json().error.code).toBe('ACCOUNT_CODE_RESERVED')
      expect(await prisma.account.count({ where: { tenantId: tid, code } })).toBe(before)
    }
    const ok = await call('finB', 'POST', '/setup/chart-of-accounts', { code: '6250', name: 'Outside the range', type: 'expense' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().tenantId).toBe(tenantB)
  })
})
