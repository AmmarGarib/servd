// On-account clients — the admin API (receivables/customerAccounts.ts) and its
// approvals provider (approvals/onAccountProvider.ts). Resumed 2026-10-15.
//
//   - Two companies: company B gets 404 on every route of company A's client
//     and cards; a create binds to the ACTIVE company; a brand of another
//     company is 422 (on create and on edit).
//   - The CEO approves a new client and every limit increase; approve is 409
//     TILL_CLEARING_NOT_SPLIT until the company is cut over; a pending client
//     cannot be charged; a decrease applies at once; only the CEO reactivates;
//     closing needs nothing owed; non-CEO approve 403 (self-approval 403).
//   - Cards: the code is returned once; the DB keeps only the hash and hint;
//     rotate kills the old card; no audit row ever holds the code.
//   - Reminders: once per Karachi day; a test company sends nothing.
//   - fnb_manager (a financials viewer) is refused; the tie-out is per company.
//   - The approvals inbox lists A's pending client to A's CEO only.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

// The SMTP transport: count what would have gone out (nothing leaves the box).
const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: 'test' }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }))
process.env.SMTP_USER = process.env.SMTP_USER || 'test-user'
process.env.SMTP_PASS = process.env.SMTP_PASS || 'test-pass'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { customerAccountRoutes } = await import('../src/modules/receivables/customerAccounts.js')
const { assertChargeableTx, lockAccountTx } = await import('../src/modules/receivables/onAccount.js')
const { tillClearingCutoverKey } = await import('../src/modules/accounting/tillClearingCode.js')
const { hashCardCode, normalizeCardCode, cardHintOf } = await import('../src/lib/onAccountCard.js')
const { onAccountClients } = await import('../src/modules/approvals/onAccountProvider.js')
const { APPROVAL_PROVIDERS } = await import('../src/modules/approvals/providers.js')
const { toCents } = await import('../src/lib/money.js')

const RUN = Math.random().toString(36).slice(2, 8)
const CA = '/accounting/customer-accounts'

let app: FastifyInstance
let tA: string, tB: string, tT: string
let brandA: string, brandA2: string, brandB: string, brandT: string
const token: Record<string, string> = {}
const uid: Record<string, string> = {}

async function mkStaff(key: string, role: UserRole, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@oaclients.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  token[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  uid[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token[who]}`, ...headers } })

type Row = {
  id: string; tenantId: string; number: string; status: string; creditLimitCents: number; requestedCreditLimitCents: number | null
  pending: string | null; exposureCents: number; availableCents: number; unbilledCents: number; cardsActive: number
  overdue: unknown; canApprove: boolean; approveBlockedReason: string | null
}

async function create(who: string, extra: Record<string, unknown> = {}) {
  const res = await call(who, 'POST', CA, { legalName: `Client ${Math.random().toString(36).slice(2, 8)} ${RUN}`, creditLimitCents: 500_000_00, ...extra })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as Row
}
const cutOver = (tenantId: string) =>
  prisma.setting.upsert({ where: { key: tillClearingCutoverKey(tenantId) }, create: { key: tillClearingCutoverKey(tenantId), value: new Date().toISOString() }, update: {} })

let orderSeq = 0
/** An unbilled on-account charge of `amountCents` on the client (a till order + its payment). */
async function charge(accountId: string, tenantId: string, conceptId: string, amountCents: number) {
  const order = await prisma.order.create({
    data: { conceptId, source: 'pos', status: 'completed', totalCents: amountCents, placedAt: new Date(), externalId: `oa-${RUN}-${++orderSeq}` },
  })
  const payment = await prisma.payment.create({ data: { orderId: order.id, method: 'on_account', amountCents, status: 'paid' } })
  return prisma.customerAccountCharge.create({
    data: { tenantId, accountId, orderId: order.id, paymentId: payment.id, conceptId, amountCents, chargedById: uid.finA! },
  })
}

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'OA Co A', slug: `oa-a-${RUN}` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'OA Co B', slug: `oa-b-${RUN}` } })).id
  tT = (await prisma.tenant.create({ data: { name: 'OA Test Co', slug: `oa-t-${RUN}`, isTest: true } })).id
  for (const t of [tA, tB, tT]) await ensureChartOfAccounts(t)
  brandA = (await prisma.concept.create({ data: { name: 'Kitchen A', slug: `oa-a-${RUN}`, type: 'restaurant', tenantId: tA, email: 'accounts@kitchen-a.test' } })).id
  brandA2 = (await prisma.concept.create({ data: { name: 'Cafe A', slug: `oa-a2-${RUN}`, type: 'restaurant', tenantId: tA } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Kitchen B', slug: `oa-b-${RUN}`, type: 'restaurant', tenantId: tB } })).id
  brandT = (await prisma.concept.create({ data: { name: 'Kitchen T', slug: `oa-t-${RUN}`, type: 'restaurant', tenantId: tT } })).id
  await mkStaff('ceoA', 'admin', tA)
  await mkStaff('finA', 'finance', tA)
  await mkStaff('mgmtA', 'management', tA)
  await mkStaff('fnbA', 'fnb_manager', tA)
  await mkStaff('ceoB', 'admin', tB)
  await mkStaff('finB', 'finance', tB)
  await mkStaff('finT', 'finance', tT)
  await mkStaff('ceoAB', 'admin', tA, [tB])
  // Finance for both companies, working in A.
  await mkStaff('finAB', 'finance', tA, [tB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(customerAccountRoutes, { prefix: CA })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('two companies', () => {
  it('a create binds to the active company; a brand of another company is 422', async () => {
    const row = await create('finAB', { conceptIds: [brandA] })
    expect(row.tenantId).toBe(tA)
    expect(row.number).toMatch(/^OA-\d{4}$/)
    expect(row.status).toBe('pending')
    const foreign = await call('finAB', 'POST', CA, { legalName: `Foreign brand ${RUN}`, creditLimitCents: 100_00, conceptIds: [brandB] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
    // Editing: brands are re-checked against the client's own company.
    const edit = await call('finAB', 'PATCH', `${CA}/${row.id}`, { conceptIds: [brandA, brandB] })
    expect(edit.statusCode).toBe(422)
    expect((await call('finAB', 'PATCH', `${CA}/${row.id}`, { conceptIds: [brandA, brandA2] })).statusCode).toBe(200)
    // B's numbers start again at OA-0001; a duplicate legal name is 409 in the same company only.
    const b = await create('finB', { legalName: 'Same Name Ltd' })
    expect(b.tenantId).toBe(tB)
    expect(b.number).toBe('OA-0001')
    await create('finA', { legalName: 'Same Name Ltd' })
    const dup = await call('finA', 'POST', CA, { legalName: 'Same Name Ltd', creditLimitCents: 100_00 })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('CLIENT_NAME_TAKEN')
  })

  it("company B gets 404 on every route of A's client and cards", async () => {
    await cutOver(tA)
    const row = await create('finA')
    expect((await call('ceoA', 'POST', `${CA}/${row.id}/approve`, {})).statusCode).toBe(200)
    const issued = await call('finA', 'POST', `${CA}/${row.id}/cards`, { label: 'Reception' })
    expect(issued.statusCode, issued.body).toBe(201)
    const cardId = (issued.json() as { card: { id: string } }).card.id
    const tries: Array<[string, 'GET' | 'POST' | 'PATCH', string, unknown]> = [
      ['finB', 'GET', `${CA}/${row.id}`, undefined],
      ['finB', 'GET', `${CA}/${row.id}/charges`, undefined],
      ['finB', 'PATCH', `${CA}/${row.id}`, { notes: 'x' }],
      ['ceoB', 'POST', `${CA}/${row.id}/approve`, {}],
      ['ceoB', 'POST', `${CA}/${row.id}/reject`, { note: 'not yours' }],
      ['finB', 'POST', `${CA}/${row.id}/cards`, { label: 'x' }],
      ['finB', 'POST', `${CA}/${row.id}/cards/${cardId}/rotate`, {}],
      ['finB', 'POST', `${CA}/${row.id}/cards/${cardId}/revoke`, { reason: 'lost it' }],
      ['finB', 'POST', `${CA}/${row.id}/remind`, {}],
    ]
    for (const [who, method, url, body] of tries) {
      const res = await call(who, method, url, body)
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
    // B's list never shows A's clients.
    const list = (await call('finB', 'GET', CA)).json() as { items: Row[] }
    expect(list.items.every((r) => r.tenantId === tB)).toBe(true)
    // A card of another client of the same company is 404 too.
    const other = await create('ceoA')
    expect(other.status).toBe('active')
    expect((await call('finA', 'POST', `${CA}/${other.id}/cards/${cardId}/rotate`, {})).statusCode).toBe(404)
  })

  it('fnb_manager is refused (client NTNs and limits stay with finance)', async () => {
    const row = await create('finA')
    expect((await call('fnbA', 'GET', CA)).statusCode).toBe(403)
    expect((await call('fnbA', 'GET', `${CA}/${row.id}`)).statusCode).toBe(403)
    expect((await call('fnbA', 'POST', CA, { legalName: 'fnb', creditLimitCents: 100 })).statusCode).toBe(403)
    expect((await call('mgmtA', 'GET', `${CA}/${row.id}`)).statusCode).toBe(200)
  })

  it('the tie-out is per company in scope', async () => {
    const one = await call('ceoAB', 'GET', `${CA}/tie-out`)
    expect(one.statusCode, one.body).toBe(200)
    expect((one.json() as { companies: Array<{ tenantId: string }> }).companies.map((c) => c.tenantId)).toEqual([tA])
    const both = await call('ceoAB', 'GET', `${CA}/tie-out`, undefined, { 'x-servd-portfolio': '1' })
    const ids = (both.json() as { companies: Array<{ tenantId: string; gl1110: number }> }).companies.map((c) => c.tenantId).sort()
    expect(ids).toEqual([tA, tB].sort())
    expect((await call('finB', 'GET', `${CA}/tie-out`)).json().companies.map((c: { tenantId: string }) => c.tenantId)).toEqual([tB])
  })
})

describe('the CEO approves', () => {
  it('approve is 409 TILL_CLEARING_NOT_SPLIT until the company is cut over; a pending client cannot be charged', async () => {
    // Company B is not cut over.
    const row = await create('finB')
    const listed = ((await call('ceoB', 'GET', `${CA}?pending=1`)).json() as { items: Row[] }).items.find((r) => r.id === row.id)!
    expect(listed.approveBlockedReason).toBeTruthy()
    expect(listed.canApprove).toBe(false)
    const res = await call('ceoB', 'POST', `${CA}/${row.id}/approve`, {})
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('TILL_CLEARING_NOT_SPLIT')
    // The CEO's own create waits too until the cut-over.
    expect((await create('ceoB')).status).toBe('pending')

    await cutOver(tB)
    const pending = await prisma.customerAccount.findUniqueOrThrow({ where: { id: row.id } })
    await expect(prisma.$transaction((tx) => assertChargeableTx(tx, pending, { conceptId: brandB, billCents: 100_00 })))
      .rejects.toMatchObject({ code: 'ON_ACCOUNT_NOT_ACTIVE' })
    expect((await call('ceoB', 'POST', `${CA}/${row.id}/approve`, {})).statusCode).toBe(200)
    const active = await prisma.customerAccount.findUniqueOrThrow({ where: { id: row.id } })
    expect(active).toMatchObject({ status: 'active', approvedById: uid.ceoB })
    await prisma.$transaction(async (tx) => {
      const locked = await lockAccountTx(tx, row.id)
      await expect(assertChargeableTx(tx, locked, { conceptId: brandB, billCents: 100_00 })).resolves.toMatchObject({ exposureCents: 0 })
    })
    // Nothing left to decide.
    const again = await call('ceoB', 'POST', `${CA}/${row.id}/approve`, {})
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('NOTHING_PENDING')
  })

  it('only the CEO approves; a requester never approves their own (403)', async () => {
    const row = await create('mgmtA')
    for (const who of ['finA', 'mgmtA', 'fnbA']) {
      expect((await call(who, 'POST', `${CA}/${row.id}/approve`, {})).statusCode, who).toBe(403)
    }
    // The CEO's own request is the one exemption (decision 27).
    const own = await call('ceoA', 'PATCH', `${CA}/${row.id}`, { notes: 'checked' })
    expect(own.statusCode).toBe(200)
    expect((await call('ceoA', 'POST', `${CA}/${row.id}/approve`, {})).statusCode).toBe(200)
  })

  it('reject needs a note; a rejected application can be sent back', async () => {
    const row = await create('finA')
    expect((await call('ceoA', 'POST', `${CA}/${row.id}/reject`, {})).statusCode).toBe(400)
    const rej = await call('ceoA', 'POST', `${CA}/${row.id}/reject`, { note: 'No trade references' })
    expect(rej.statusCode).toBe(200)
    expect(rej.json()).toMatchObject({ status: 'closed', pending: null })
    expect((await call('finA', 'POST', `${CA}/${row.id}/cards`, { label: 'x' })).statusCode).toBe(409)
    const back = await call('finA', 'PATCH', `${CA}/${row.id}`, { status: 'pending', notes: 'References attached' })
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json()).toMatchObject({ status: 'pending', pending: 'new_client' })
  })

  it('a limit increase waits for the CEO; a decrease applies at once; only the CEO reactivates', async () => {
    const row = await create('finA', { creditLimitCents: 100_000_00 })
    await call('ceoA', 'POST', `${CA}/${row.id}/approve`, {})
    const up = await call('finA', 'PATCH', `${CA}/${row.id}`, { creditLimitCents: 300_000_00 })
    expect(up.json()).toMatchObject({ creditLimitCents: 100_000_00, requestedCreditLimitCents: 300_000_00, pending: 'limit_increase' })
    // The requester (or any non-CEO) cannot approve it.
    expect((await call('finA', 'POST', `${CA}/${row.id}/approve`, {})).statusCode).toBe(403)
    const ok = await call('ceoA', 'POST', `${CA}/${row.id}/approve`, {})
    expect(ok.json()).toMatchObject({ creditLimitCents: 300_000_00, requestedCreditLimitCents: null, pending: null })
    // A decrease applies at once (and drops any increase still waiting).
    await call('finA', 'PATCH', `${CA}/${row.id}`, { creditLimitCents: 400_000_00 })
    const down = await call('finA', 'PATCH', `${CA}/${row.id}`, { creditLimitCents: 50_000_00 })
    expect(down.json()).toMatchObject({ creditLimitCents: 50_000_00, requestedCreditLimitCents: null, status: 'active' })
    // The CEO's own increase applies directly.
    expect((await call('ceoA', 'PATCH', `${CA}/${row.id}`, { creditLimitCents: 80_000_00 })).json()).toMatchObject({ creditLimitCents: 80_000_00, pending: null })

    // Suspend needs a reason; reactivating is the CEO's.
    expect((await call('finA', 'PATCH', `${CA}/${row.id}`, { status: 'suspended' })).statusCode).toBe(422)
    expect((await call('finA', 'PATCH', `${CA}/${row.id}`, { status: 'suspended', reason: 'Cheque bounced' })).json()).toMatchObject({ status: 'suspended', statusReason: 'Cheque bounced' })
    expect((await call('finA', 'PATCH', `${CA}/${row.id}`, { status: 'active' })).statusCode).toBe(403)
    expect((await call('mgmtA', 'PATCH', `${CA}/${row.id}`, { status: 'active' })).statusCode).toBe(403)
    expect((await call('ceoA', 'PATCH', `${CA}/${row.id}`, { status: 'active' })).json()).toMatchObject({ status: 'active' })
    // A new client is activated by approving it, never by PATCH.
    const fresh = await create('finA')
    expect((await call('ceoA', 'PATCH', `${CA}/${fresh.id}`, { status: 'active' })).statusCode).toBe(409)

    const audits = await prisma.auditLog.findMany({ where: { entityId: row.id, tenantId: tA }, select: { action: true } })
    const actions = audits.map((a) => a.action)
    for (const a of ['on_account.client.create', 'on_account.client.limit_requested', 'on_account.client.approve', 'on_account.client.limit_lowered', 'on_account.client.suspended', 'on_account.client.reactivated']) {
      expect(actions, a).toContain(a)
    }
  })

  it('closing needs nothing owed; a closed client has no live cards', async () => {
    const row = await create('ceoA', { conceptIds: [brandA] })
    await call('finA', 'POST', `${CA}/${row.id}/cards`, { label: 'Front desk' })
    const c = await charge(row.id, tA, brandA, 12_500_00)
    const list = ((await call('finA', 'GET', CA)).json() as { items: Row[] }).items.find((r) => r.id === row.id)!
    expect(list).toMatchObject({ unbilledCents: 12_500_00, exposureCents: 12_500_00, availableCents: 500_000_00 - 12_500_00, cardsActive: 1 })
    const refused = await call('finA', 'PATCH', `${CA}/${row.id}`, { status: 'closed' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('CLIENT_HAS_BALANCE')
    // Charges list: Karachi-day bounds, unbilled only, not yet booked (no drawer close).
    const today = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
    const charges = (await call('finA', 'GET', `${CA}/${row.id}/charges?from=${today}&to=${today}&unbilled=1`)).json() as { items: Array<{ id: string; booked: boolean; netCents: number }> }
    expect(charges.items).toEqual([expect.objectContaining({ id: c.id, booked: false, netCents: 12_500_00 })])
    expect(((await call('finA', 'GET', `${CA}/${row.id}/charges?to=2020-01-01`)).json() as { items: unknown[] }).items).toEqual([])
    const detail = (await call('finA', 'GET', `${CA}/${row.id}`)).json() as { unbilled: { notBookedCents: number }; cards: Array<Record<string, unknown>> }
    expect(detail.unbilled.notBookedCents).toBe(12_500_00)
    for (const card of detail.cards) expect(card).not.toHaveProperty('tokenHash')
    // Fully refunded → nothing owed → it closes, and its cards die.
    await prisma.customerAccountCharge.update({ where: { id: c.id }, data: { refundedCents: 12_500_00 } })
    const closed = await call('finA', 'PATCH', `${CA}/${row.id}`, { status: 'closed', reason: 'Contract ended' })
    expect(closed.json()).toMatchObject({ status: 'closed', cardsActive: 0 })
    expect((await call('finA', 'PATCH', `${CA}/${row.id}`, { notes: 'x' })).statusCode).toBe(409)
  })
})

describe('cards', () => {
  it('the code is returned once; the DB keeps the hash and hint; rotate kills the old code; no audit row holds it', async () => {
    const row = await create('ceoA')
    const pendingRow = await create('finA')
    expect((await call('finA', 'POST', `${CA}/${pendingRow.id}/cards`, { label: 'x' })).json().error.code).toBe('CLIENT_NOT_APPROVED')

    const res = await call('finA', 'POST', `${CA}/${row.id}/cards`, { label: 'Mr Khan' })
    expect(res.statusCode).toBe(201)
    const { card, code } = res.json() as { card: { id: string; hint: string }; code: string }
    expect(code).toMatch(/^SVOA(-[0-9A-Z]{5}){4}$/)
    const norm = normalizeCardCode(code)!
    const stored = await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: card.id } })
    expect(stored.tokenHash).toBe(hashCardCode(norm))
    expect(stored.tokenHint).toBe(cardHintOf(norm))
    expect(card.hint).toBe(stored.tokenHint)
    expect(JSON.stringify(stored)).not.toContain(norm)
    // Read back: never the code, never the hash.
    const detail = (await call('finA', 'GET', `${CA}/${row.id}`)).body
    expect(detail).not.toContain(norm)
    expect(detail).not.toContain(stored.tokenHash)

    const rot = await call('finA', 'POST', `${CA}/${row.id}/cards/${card.id}/rotate`, {})
    expect(rot.statusCode).toBe(200)
    const rotated = rot.json() as { card: { id: string; active: boolean }; code: string; replacedCardId: string }
    expect(rotated.code).not.toBe(code)
    expect(rotated.replacedCardId).toBe(card.id)
    const old = await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: card.id } })
    expect(old.revokedAt).not.toBeNull()
    expect(old.revokedReason).toBe('rotated')
    // The old code's hash now finds only a revoked card.
    const byOld = await prisma.customerAccountCard.findFirst({ where: { tenantId: tA, tokenHash: hashCardCode(norm), revokedAt: null } })
    expect(byOld).toBeNull()
    expect((await call('finA', 'POST', `${CA}/${row.id}/cards/${card.id}/rotate`, {})).json().error.code).toBe('CARD_REVOKED')

    const rev = await call('finA', 'POST', `${CA}/${row.id}/cards/${rotated.card.id}/revoke`, { reason: 'Lost' })
    expect(rev.json()).toMatchObject({ card: { active: false, revokedReason: 'Lost' } })
    expect((await call('finA', 'POST', `${CA}/${row.id}/cards/${rotated.card.id}/revoke`, { reason: 'Lost' })).statusCode).toBe(409)

    // No audit row carries either code (only hints).
    const audits = await prisma.auditLog.findMany({ where: { tenantId: tA } })
    const text = JSON.stringify(audits)
    for (const c of [code, rotated.code]) {
      expect(text).not.toContain(c)
      expect(text).not.toContain(normalizeCardCode(c)!)
    }
    expect(audits.filter((a) => a.action.startsWith('on_account.card.')).map((a) => a.action).sort())
      .toEqual(expect.arrayContaining(['on_account.card.issue', 'on_account.card.revoke', 'on_account.card.rotate']))
  })
})

describe('reminders', () => {
  async function overdueClient(tenantId: string, conceptId: string, who: string) {
    const row = await create(who, { contactEmail: 'ap@client.test', contactName: 'Accounts Payable', conceptIds: [conceptId] })
    await prisma.receivableInvoice.create({
      data: {
        tenantId, conceptId, number: `AR-OA-${Math.random().toString(36).slice(2, 7)}`, customerName: 'Client', customerAccountId: row.id,
        issueDate: new Date('2026-08-01'), dueDate: new Date('2026-08-31'), description: 'Catering', amountCents: 40_000_00, taxCents: 6_000_00,
      },
    })
    return row
  }

  it('sends once per Karachi day, from the company reply-to; 422 without an email', async () => {
    const row = await overdueClient(tA, brandA, 'ceoA')
    sendMail.mockClear()
    const first = await call('finA', 'POST', `${CA}/${row.id}/remind`, {})
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ sent: true })
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ to: 'ap@client.test', replyTo: 'accounts@kitchen-a.test' })
    expect(String(sendMail.mock.calls[0]![0].html)).toContain('PKR 46,000')
    const second = await call('finA', 'POST', `${CA}/${row.id}/remind`, {})
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('REMINDED_TODAY')
    expect(sendMail).toHaveBeenCalledTimes(1)
    // Yesterday's reminder does not block today's.
    await prisma.customerAccount.update({ where: { id: row.id }, data: { lastRemindedAt: new Date(Date.now() - 2 * 86_400_000) } })
    expect((await call('finA', 'POST', `${CA}/${row.id}/remind`, {})).statusCode).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(2)

    const noEmail = await create('finA')
    const res = await call('finA', 'POST', `${CA}/${noEmail.id}/remind`, {})
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('NO_EMAIL')
  })

  it('a test company sends nothing', async () => {
    await cutOver(tT)
    const row = await overdueClient(tT, brandT, 'finT')
    sendMail.mockClear()
    const res = await call('finT', 'POST', `${CA}/${row.id}/remind`, {})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ sent: false, skipped: 'test_company' })
    expect(sendMail).not.toHaveBeenCalled()
  })
})

describe('approvals provider', () => {
  it('is registered, CEO-only and never delegable', () => {
    expect(APPROVAL_PROVIDERS).toContain(onAccountClients)
    expect(onAccountClients).toMatchObject({ type: 'on_account_client', module: 'accounting', link: '/accounting/receivables/clients', delegable: false, approverRoles: ['admin'] })
  })

  it("maps A's pending rows through the module's own queue route", async () => {
    const newClient = await create('finA', { legalName: `Provider New ${RUN}`, creditLimitCents: 200_000_00, termsDays: 45, conceptIds: [brandA] })
    const raise = await create('ceoA', { legalName: `Provider Raise ${RUN}`, creditLimitCents: 100_000_00 })
    await call('finA', 'PATCH', `${CA}/${raise.id}`, { creditLimitCents: 150_000_00 })
    const ctx = (who: string) => ({
      user: { id: uid[who]!, role: 'admin' as const },
      tenantIds: [tA], memberTenantIds: [tA],
      async read<T>(path: string): Promise<T | null> {
        const res = await call(who, 'GET', `${CA}${path.slice(CA.length)}`)
        return res.statusCode >= 400 ? null : (res.json() as T)
      },
    })
    const items = (await onAccountClients.load(ctx('ceoA')))!
    const n = items.find((i) => i.id === newClient.id)!
    expect(n.tenantId).toBe(tA)
    expect(n.submittedByIds).toEqual([uid.finA])
    expect(n.facts).toEqual(expect.arrayContaining([
      { label: 'Request', value: 'New on-account client' },
      { label: 'Credit limit', value: 'PKR 200,000' },
      { label: 'Terms', value: "45 days, 7 days' grace" },
      { label: 'Brands', value: 'Kitchen A' },
    ]))
    expect(n.actions.map((a) => a.path)).toEqual([`${CA}/${newClient.id}/approve`, `${CA}/${newClient.id}/reject`])
    expect(n.actions[1]!.input).toMatchObject({ field: 'note', required: true })
    const r = items.find((i) => i.id === raise.id)!
    expect(r.facts).toEqual(expect.arrayContaining([
      { label: 'Request', value: 'Credit limit increase' },
      { label: 'New limit', value: 'PKR 150,000' },
      { label: 'Current limit', value: 'PKR 100,000' },
    ]))
    // Nothing of company A reaches company B's CEO.
    const b = (await onAccountClients.load(ctx('ceoB')))!
    expect(b.every((i) => i.tenantId === tB)).toBe(true)
    // fnb_manager's queue read is refused → the type is not theirs at all.
    expect(await onAccountClients.load(ctx('fnbA'))).toBeNull()
  })

  it('approving applies only what the CEO saw: a later edit is 409 REQUEST_CHANGED and nothing changes', async () => {
    const ctx = (who: string) => ({
      user: { id: uid[who]!, role: 'admin' as const },
      tenantIds: [tA], memberTenantIds: [tA],
      async read<T>(path: string): Promise<T | null> {
        const res = await call(who, 'GET', `${CA}${path.slice(CA.length)}`)
        return res.statusCode >= 400 ? null : (res.json() as T)
      },
    })
    const approveOf = async (id: string) => {
      const item = (await onAccountClients.load(ctx('ceoA')))!.find((i) => i.id === id)!
      return item.actions.find((a) => a.kind === 'approve')!
    }
    // A limit increase: the CEO opens the inbox at 300k, finance then asks for 3M.
    const raise = await create('ceoA', { legalName: `Stale Raise ${RUN}`, creditLimitCents: 100_000_00 })
    await call('finA', 'PATCH', `${CA}/${raise.id}`, { creditLimitCents: 300_000_00 })
    const seen = await approveOf(raise.id)
    expect(seen.body).toMatchObject({ creditLimitCents: 300_000_00, expectedUpdatedAt: expect.any(String) })
    await call('finA', 'PATCH', `${CA}/${raise.id}`, { creditLimitCents: 3_000_000_00 })
    const stale = await call('ceoA', 'POST', seen.path, seen.body)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('REQUEST_CHANGED')
    const still = await prisma.customerAccount.findUniqueOrThrow({ where: { id: raise.id } })
    expect(toCents(still.creditLimitCents)).toBe(100_000_00)
    expect(toCents(still.requestedCreditLimitCents!)).toBe(3_000_000_00)
    // Only the limit sent (no timestamp) is checked too.
    expect((await call('ceoA', 'POST', seen.path, { creditLimitCents: 300_000_00 })).statusCode).toBe(409)
    // Reloaded, the CEO approves what is now shown.
    const fresh = await approveOf(raise.id)
    const ok = await call('ceoA', 'POST', fresh.path, fresh.body)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ creditLimitCents: 3_000_000_00, pending: null })

    // A new client: terms edited after the inbox loaded → the stale approval is refused.
    const newClient = await create('finA', { legalName: `Stale New ${RUN}`, creditLimitCents: 200_000_00 })
    const seenNew = await approveOf(newClient.id)
    await new Promise((r) => setTimeout(r, 5))
    await call('finA', 'PATCH', `${CA}/${newClient.id}`, { termsDays: 90 })
    const staleNew = await call('ceoA', 'POST', seenNew.path, seenNew.body)
    expect(staleNew.statusCode, staleNew.body).toBe(409)
    expect((await prisma.customerAccount.findUniqueOrThrow({ where: { id: newClient.id } })).status).toBe('pending')
    const okNew = await approveOf(newClient.id)
    expect((await call('ceoA', 'POST', okNew.path, okNew.body)).json()).toMatchObject({ status: 'active', termsDays: 90 })
  })
})
