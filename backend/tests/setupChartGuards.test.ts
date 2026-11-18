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
    const own = await call('ceoA', 'POST', '/setup/chart-of-accounts', { name: 'Meezan current', type: 'asset', isBank: true })
    expect(own.statusCode, own.body).toBe(201)
    const bank = await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan', accountCode: own.json().code as string } })
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
    const created = await call('ceoA', 'POST', '/setup/chart-of-accounts', { name: 'Marketing software', type: 'expense' })
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
      name: 'Sneaky due-from', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: tenantB,
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
    const c = await call('finA', 'POST', '/setup/chart-of-accounts', { name: 'Garibsons Pvt Ltd', type: 'liability', description: 'Capital account' })
    expect(c.statusCode, c.body).toBe(201)
    expect(c.json().tenantId).toBe(tenantA)
    const id = c.json().id as string
    const r = await call('finA', 'PATCH', `/setup/chart-of-accounts/${id}`, { name: 'Garibsons (Pvt) Ltd', description: 'Project financing' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().name).toBe('Garibsons (Pvt) Ltd')
    expect((await call('finB', 'PATCH', `/setup/chart-of-accounts/${id}`, { name: 'x' })).statusCode).toBe(404)
    // A typed code is refused (owner, 2026-11-18): servd picks it.
    const typed = await call('finA', 'POST', '/setup/chart-of-accounts', { code: '9272', name: 'Again', type: 'liability' })
    expect(typed.statusCode).toBe(422)
    expect(typed.json().error.code).toBe('ACCOUNT_CODE_IS_AUTOMATIC')
    // Company B's new account is B's own, under a DIFFERENT code — no code is used twice across servd.
    const b = await call('finB', 'POST', '/setup/chart-of-accounts', { name: 'B account', type: 'liability' })
    expect(b.json().tenantId).toBe(tenantB)
    expect(b.json().code).not.toBe(c.json().code)
  })

  it('finance switches an account off and back on (owner, 2026-10-16); the books\' guards still apply', async () => {
    const id = (await call('finA', 'POST', '/setup/chart-of-accounts', { name: 'To pause', type: 'expense' })).json().id as string
    expect((await off('finA', id)).statusCode).toBe(200)
    expect((await call('finA', 'PATCH', `/setup/chart-of-accounts/${id}`, { isActive: true })).statusCode).toBe(200)
    const req = await off('finA', await accountId(tenantA, '2210'))
    expect(req.statusCode).toBe(422)
    expect(req.json().error.code).toBe('ACCOUNT_IN_USE')
  })

  it('other roles, and finance without the accounting module, are refused', async () => {
    for (const who of ['mgmtA', 'cashA', 'finNoMod']) {
      const r = await call(who, 'POST', '/setup/chart-of-accounts', { name: 'No', type: 'expense' })
      expect(r.statusCode, who).toBe(403)
    }
  })
})

// Owner, 2026-11-18: "account code should not decide where an account balance will reflect in P&L or BS. Accounts
// codes should be picked on auto and each account will carry a unique code, no duplication."
describe('codes are picked by servd; where an account shows is stored on it', () => {
  const lead = (code: string) => Number(code.slice(0, 4))
  const reserved = (n: number) => (n >= 1400 && n <= 1599) || n === 2012 || (n >= 2100 && n <= 2199) || (n >= 6200 && n <= 6249) || (n >= 6990 && n <= 6999)

  it('a new account gets a free code no company uses, never in a range a module owns, never a template code', async () => {
    const { CHART_OF_ACCOUNTS } = await import('../src/lib/chartOfAccounts.js')
    const template = new Set(CHART_OF_ACCOUNTS.map((a) => a.code))
    const seen = new Set<string>()
    for (const [who, body] of [
      ['finA', { name: 'Auto asset', type: 'asset' }], ['finB', { name: 'Auto asset B', type: 'asset' }],
      ['finA', { name: 'Auto bank', type: 'asset', isBank: true }], ['finA', { name: 'Auto liability', type: 'liability' }],
      ['ceoA', { name: 'Auto equity', type: 'equity' }], ['finA', { name: 'Auto revenue', type: 'revenue' }],
      ['finA', { name: 'Auto other income', type: 'revenue', plSection: 'other_income' }],
      ['finA', { name: 'Auto opex', type: 'expense' }], ['finB', { name: 'Auto opex B', type: 'expense' }],
      ['finA', { name: 'Auto cost of sales', type: 'expense', plSection: 'cost_of_sales' }],
    ] as const) {
      const res = await call(who, 'POST', '/setup/chart-of-accounts', body)
      expect(res.statusCode, `${body.name} ${res.body}`).toBe(201)
      const code = res.json().code as string
      expect(code, body.name).toMatch(/^\d{4}$/)
      expect(reserved(lead(code)), `${body.name} ${code}`).toBe(false)
      expect(template.has(code), `${body.name} ${code}`).toBe(false)
      expect(seen.has(code), `${body.name} reused ${code}`).toBe(false)
      seen.add(code)
      expect(await prisma.account.count({ where: { code } }), `${code} is used once across servd`).toBe(1)
    }
    // A bank account's code is in the 10xx band the bank link needs.
    const bank = await prisma.account.findFirstOrThrow({ where: { tenantId: tenantA, name: 'Auto bank' } })
    expect(bank.code).toMatch(/^10\d\d$/)
  })

  it('an expense with no section named is an OPERATING expense; the section is stored and listed', async () => {
    const res = await call('finA', 'POST', '/setup/chart-of-accounts', { name: 'IT expense', type: 'expense' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().plSection).toBe('operating_expense')
    const cos = await call('finA', 'POST', '/setup/chart-of-accounts', { name: 'Kitchen gas', type: 'expense', plSection: 'cost_of_sales' })
    expect(cos.json().plSection).toBe('cost_of_sales')
    const list = (await call('ceoA', 'GET', '/setup/chart-of-accounts')).json() as Array<{ code: string; plSection: string | null; sectionFixed: boolean }>
    expect(list.find((a) => a.code === res.json().code)!.plSection).toBe('operating_expense')
    expect(list.find((a) => a.code === '5010')!.plSection).toBe('cost_of_sales')
    expect(list.find((a) => a.code === '5010')!.sectionFixed).toBe(true)
    expect(list.find((a) => a.code === '4200')!.plSection).toBe('other_income')
    expect(list.find((a) => a.code === '1010')!.plSection).toBeNull()
    // A section that does not fit the type, or one on a balance-sheet account, is refused.
    expect((await call('finA', 'POST', '/setup/chart-of-accounts', { name: 'X', type: 'expense', plSection: 'other_income' })).json().error.code).toBe('SECTION_NOT_FOR_TYPE')
    expect((await call('finA', 'POST', '/setup/chart-of-accounts', { name: 'X', type: 'asset', plSection: 'cost_of_sales' })).json().error.code).toBe('SECTION_NOT_FOR_TYPE')
  })

  it('the P&L follows the stored section, not the code: a 5-coded account set to Operating expenses leaves cost of sales', async () => {
    const { profitAndLoss } = await import('../src/modules/accounting/reports.js')
    const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
    // The owner's case: an IT expense account that was opened by hand under a 5-code.
    const it5 = await prisma.account.create({ data: { tenantId: tenantA, code: '5871', name: 'IT Expense', type: 'expense', plSection: 'cost_of_sales' } })
    await postJournalEntry({ tenantId: tenantA, entryDate: new Date('2026-11-10T08:00:00Z'), description: 'IT bill', sourceType: 'manual', sourceId: `it-${P}`,
      lines: [{ accountCode: '5871', type: 'debit', amountCents: 250_000 }, { accountCode: '1010', type: 'credit', amountCents: 250_000 }] })
    const from = new Date('2026-11-01T00:00:00Z'); const to = new Date('2026-11-30T23:59:59Z')
    const before = await profitAndLoss([tenantA], from, to)
    expect(before.cogs.find((r) => r.code === '5871')?.amountCents).toBe(250_000)
    // Company B cannot move it (404); the wrong kind of section is refused; A's finance moves it.
    expect((await call('finB', 'PATCH', `/setup/chart-of-accounts/${it5.id}`, { plSection: 'operating_expense' })).statusCode).toBe(404)
    expect((await call('finA', 'PATCH', `/setup/chart-of-accounts/${it5.id}`, { plSection: 'other_income' })).json().error.code).toBe('SECTION_NOT_FOR_TYPE')
    const moved = await call('finA', 'PATCH', `/setup/chart-of-accounts/${it5.id}`, { plSection: 'operating_expense' })
    expect(moved.statusCode, moved.body).toBe(200)
    const after = await profitAndLoss([tenantA], from, to)
    expect(after.cogs.find((r) => r.code === '5871')).toBeUndefined()
    expect(after.opex.find((r) => r.code === '5871')?.amountCents).toBe(250_000)
    expect(after.totals.cogsCents).toBe(before.totals.cogsCents - 250_000)
    expect(after.totals.netProfitCents).toBe(before.totals.netProfitCents)
    expect(after.totals.grossProfitCents).toBe(before.totals.grossProfitCents + 250_000)
  })

  it("an account servd posts to itself keeps its section (422 SECTION_FIXED)", async () => {
    for (const code of ['5010', '6030', '4200', '4001']) {
      const res = await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${await accountId(tenantA, code)}`, { plSection: code.startsWith('4') ? (code === '4200' ? 'revenue' : 'other_income') : (code === '5010' ? 'operating_expense' : 'cost_of_sales') })
      expect(res.statusCode, `${code} ${res.body}`).toBe(422)
      expect(res.json().error.code).toBe('SECTION_FIXED')
    }
  })
})

// Current / non-current (owner, 2026-10-31; lib/accountTerm.ts).
describe('current / non-current on assets and liabilities', () => {
  it('defaults by code, takes a pick on assets and liabilities only, and stays per company', async () => {
    const { defaultTermOf } = await import('../src/lib/accountTerm.js')
    expect(defaultTermOf('1010', 'asset')).toBe('current')
    expect(defaultTermOf('1210', 'asset')).toBe('current')
    expect(defaultTermOf('1510', 'asset')).toBe('non_current')
    expect(defaultTermOf('1591', 'asset')).toBe('non_current')
    expect(defaultTermOf('1360', 'asset')).toBe('non_current')
    expect(defaultTermOf('2010', 'liability')).toBe('current')
    expect(defaultTermOf('2210', 'liability')).toBe('non_current')
    expect(defaultTermOf('6030', 'expense')).toBeNull()

    const list = (await call('ceoA', 'GET', '/setup/chart-of-accounts')).json() as Array<{ code: string; term: string | null }>
    expect(list.find((a) => a.code === '1510')!.term).toBe('non_current')
    expect(list.find((a) => a.code === '1010')!.term).toBe('current')
    expect(list.find((a) => a.code === '4090')?.term ?? null).toBeNull()

    // A new non-current asset; an expense refuses a term.
    const created = await call('ceoA', 'POST', '/setup/chart-of-accounts', { name: 'Long-term loan to staff', type: 'asset', classification: 'non_current' })
    expect(created.statusCode, created.body).toBe(201)
    expect((await call('ceoA', 'POST', '/setup/chart-of-accounts', { name: 'X', type: 'expense', classification: 'current' })).statusCode).toBe(422)
    // Move 1310 to non-current, then back to the default.
    const id1310 = await accountId(tenantA, '1310')
    expect((await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${id1310}`, { classification: 'non_current' })).statusCode).toBe(200)
    const after = (await call('ceoA', 'GET', '/setup/chart-of-accounts')).json() as Array<{ code: string; term: string }>
    expect(after.find((a) => a.code === '1310')!.term).toBe('non_current')
    // Company B's 1310 is untouched, and B cannot edit A's.
    const bList = (await call('ceoB', 'GET', '/setup/chart-of-accounts')).json() as Array<{ code: string; term: string }>
    expect(bList.find((a) => a.code === '1310')!.term).toBe('current')
    expect((await call('ceoB', 'PATCH', `/setup/chart-of-accounts/${id1310}`, { classification: 'current' })).statusCode).toBe(404)
    expect((await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${id1310}`, { classification: null })).statusCode).toBe(200)
  })
})
