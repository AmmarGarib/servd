// The Journals tab (owner, 2026-10-23): "store all the Journal entries (Payment
// journals and receiving journal separately) to find the entries in no time,
// and also option to edit/cancel/void any back dated or current Journal manual
// entry with final approval of CEO … CEO approve edits only when amount is
// edited, not for editing details/particulars/Memo."
//
//   - a TEXT edit (description / reference / memos) applies at once, in place, audited;
//   - finance's MONEY edit / cancel → 202, a journal request (amend / reverse) for the
//     CEO; nothing posts until the CEO approves; approval runs the existing engine;
//   - reject (note ≥10) leaves the books alone; ENTRY_CHANGED, CHANGE_PENDING;
//     finance never approves; closed books stay the CEO's;
//   - registers: payment / receipt / manual / all, money-to-money transfers out,
//     sales only with includeSales; cursor paging; export;
//   - the account statement (Accounts view): paging, brand filter, row rights;
//   - two companies: B gets 404 on A's entries, requests and accounts; lists scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { parsePktEndOfDay, fmtPktDate } = await import('../src/modules/accounting/dates.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { setupRoutes } = await import('../src/modules/setup/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')

const P = `jt${Date.now()}`
let A = ''
let B = ''
let brandA = ''
let brandB = ''
let app: FastifyInstance
const U: Record<string, { id: string; token: string; tenantId: string }> = {}

async function mkUser(key: string, role: string, members: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@jt.pk`, password: 'x', role: role as 'admin', tenantId: members[0]!,
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

const day = fmtPktDate(new Date(Date.now() - 10 * 86400_000))
const at = new Date(`${day}T12:00:00+05:00`).toISOString()
const two = async (cents: number, memo = 'Rent accrual') => [
  { accountId: await acct(A, '6010'), type: 'debit' as const, amountCents: cents, memo },
  { accountId: await acct(A, '1020'), type: 'credit' as const, amountCents: cents },
]
async function manual(who: string, cents: number, description = 'Office rent') {
  const res = await call(who, 'POST', '/accounting/journal', { description, reference: 'R1', entryDate: at, lines: await two(cents) })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as { id: string; reference: string; lines: Array<{ id: string; memo: string | null }> }
}
const reversalOf = (ref: string) => prisma.journalEntry.findFirst({ where: { reference: `manual.reversal:${ref.slice('manual:'.length)}` } })

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `${P} Foods`, slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `${P} Viva`, slug: `${P}-b` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  brandA = (await prisma.concept.create({ data: { name: `${P} Cafe`, slug: `${P}-cafe`, type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  brandB = (await prisma.concept.create({ data: { name: `${P} Diner`, slug: `${P}-diner`, type: 'restaurant', tenantId: B, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('ceo', 'admin', [A, B])
  await mkUser('fin', 'finance', [A])
  await mkUser('finB', 'finance', [B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(setupRoutes, { prefix: '/setup' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await prisma.periodLock.deleteMany({ where: { tenantId: { in: [A, B] } } }).catch(() => {})
  await app?.close()
})

describe('text edits apply at once', () => {
  it('description, reference and memos change in place, audited; nothing posts; company B gets 404', async () => {
    const e = await manual('fin', 50_000)
    const before = await prisma.journalEntry.count({ where: { tenantId: A } })
    const debitLine = e.lines.find((l) => l.memo === 'Rent accrual')!
    expect((await call('finB', 'PATCH', `/accounting/journal/${e.id}/text`, { description: 'x' })).statusCode).toBe(404)
    const res = await call('fin', 'PATCH', `/accounting/journal/${e.id}/text`, { description: 'Office rent — October', reference: 'INV-9', memos: [{ lineId: debitLine.id, memo: 'October rent' }] })
    expect(res.statusCode, res.body).toBe(200)
    const after = await prisma.journalEntry.findUniqueOrThrow({ where: { id: e.id }, include: { lines: true } })
    expect(after.description).toBe('Office rent — October · ref INV-9')
    expect(after.lines.find((l) => l.id === debitLine.id)!.memo).toBe('October rent')
    expect(await prisma.journalEntry.count({ where: { tenantId: A } })).toBe(before)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: e.id, action: 'journal.text_edit' } })
    expect(log.tenantId).toBe(A)
    expect(log.before).toMatchObject({ description: 'Office rent · ref R1' })
    expect(log.after).toMatchObject({ description: 'Office rent — October · ref INV-9' })
    expect((await call('fin', 'PATCH', `/accounting/journal/${e.id}/text`, { description: 'Office rent — October', reference: 'INV-9' })).statusCode).toBe(409)

    // An /amend that changes only text (same lines, same day) is a text edit too: same entry, 200.
    const t = await call('fin', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Better words', description: 'Rent', entryDate: at, lines: (await two(50_000, 'Rent Oct')).reverse() })
    expect(t.statusCode, t.body).toBe(200)
    expect(t.json()).toMatchObject({ id: e.id, edited: 'text' })
    expect(await reversalOf(e.reference)).toBeNull()

    const detail = await call('fin', 'GET', `/accounting/journals/${e.id}`)
    expect(detail.statusCode).toBe(200)
    expect(detail.json().textEdits.length).toBe(2)
    expect((await call('finB', 'GET', `/accounting/journals/${e.id}`)).statusCode).toBe(404)
  })

  it('an entry dated in closed books: finance is refused, the CEO may', async () => {
    const res = await call('ceo', 'POST', '/accounting/journal', { description: 'March accrual', entryDate: '2026-03-05T07:00:00.000Z', lines: await two(10_000) }, A)
    expect(res.statusCode, res.body).toBe(201)
    const id = res.json().id as string
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: parsePktEndOfDay('2026-03-31'), lockedBy: U.ceo!.id } })
    try {
      const f = await call('fin', 'PATCH', `/accounting/journal/${id}/text`, { description: 'March rent' })
      expect([f.statusCode, code(f)]).toEqual([403, 'CEO_ONLY_CLOSED_BOOKS'])
      const list = await call('fin', 'GET', '/accounting/journals?view=manual&q=March%20accrual')
      const row = (list.json().rows as Array<{ id: string; canTextEdit: boolean; canRequestChange: boolean }>).find((r) => r.id === id)!
      expect(row.canTextEdit).toBe(false)
      expect(row.canRequestChange).toBe(true)
      expect((await call('ceo', 'PATCH', `/accounting/journal/${id}/text`, { description: 'March rent' }, A)).statusCode).toBe(200)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})

describe('money edits and cancels wait for the CEO', () => {
  it('finance edit → 202 pending; CHANGE_PENDING; diff; finance cannot approve; the CEO approves through the existing engine', async () => {
    const e = await manual('fin', 60_000)
    const res = await call('fin', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Wrong amount', description: 'Office rent', reference: 'R1', entryDate: at, lines: await two(70_000) })
    expect(res.statusCode, res.body).toBe(202)
    const r = res.json().request
    expect(res.json().pendingApproval).toBe(true)
    expect(r).toMatchObject({ kind: 'amend', status: 'submitted', tenantId: A, targetEntryId: e.id, totalCents: 70_000 })
    expect(await reversalOf(e.reference)).toBeNull()

    // One open change per entry; text edits wait too.
    for (const [m, url, body] of [
      ['POST', `/accounting/journal/${e.id}/amend`, { reason: 'Again', description: 'x', lines: await two(80_000) }],
      ['POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Cancel it' }],
      ['PATCH', `/accounting/journal/${e.id}/text`, { description: 'y' }],
    ] as const) {
      const x = await call('fin', m, url, body)
      expect([x.statusCode, code(x)], url).toEqual([409, 'CHANGE_PENDING'])
    }
    // The CEO's own direct edit waits for the decision too.
    expect(code(await call('ceo', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Direct cancel' }, A))).toBe('CHANGE_PENDING')

    const list = await call('fin', 'GET', '/accounting/journals?view=manual&q=Office%20rent&limit=200')
    const row = (list.json().rows as Array<{ id: string; status: string; pendingChange: { requestId: string } | null; canTextEdit: boolean }>).find((x) => x.id === e.id)!
    expect(row).toMatchObject({ status: 'change_pending', canTextEdit: false })
    expect(row.pendingChange!.requestId).toBe(r.id)

    const diff = await call('ceo', 'GET', `/accounting/journal-requests/${r.id}/diff`, undefined, A)
    expect(diff.statusCode, diff.body).toBe(200)
    expect(diff.json().changes).toMatchObject({ kind: 'amend', totalBeforeCents: 60_000, totalAfterCents: 70_000 })
    expect(diff.json().changes.linesAdded).toHaveLength(2)
    expect(diff.json().stale).toBe(false)
    expect((await call('finB', 'GET', `/accounting/journal-requests/${r.id}/diff`)).statusCode).toBe(404)
    expect((await call('finB', 'POST', `/accounting/journal-requests/${r.id}/approve`, {})).statusCode).toBe(404)
    const self = await call('fin', 'POST', `/accounting/journal-requests/${r.id}/approve`, {})
    expect(self.statusCode).toBe(403)
    const short = await call('ceo', 'POST', `/accounting/journal-requests/${r.id}/reject`, { note: 'too short' }, A)
    expect([short.statusCode, code(short)]).toEqual([422, 'NOTE_TOO_SHORT'])

    const ok = await call('ceo', 'POST', `/accounting/journal-requests/${r.id}/approve`, {}, A)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().request.status).toBe('posted')
    const rev = await reversalOf(e.reference)
    expect(rev).not.toBeNull()
    expect(rev!.tenantId).toBe(A)
    expect(fmtPktDate(rev!.entryDate)).toBe(day)
    const corrected = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ok.json().entryId }, include: { lines: true } })
    expect(corrected.reference).toBe(`manual:${r.id}`)
    for (const id of [rev!.id, corrected.id]) {
      const ls = await prisma.journalLine.findMany({ where: { journalEntryId: id } })
      const dr = ls.filter((l) => l.type === 'debit').reduce((s, l) => s + Number(l.amountCents), 0)
      const cr = ls.filter((l) => l.type === 'credit').reduce((s, l) => s + Number(l.amountCents), 0)
      expect(dr).toBe(cr)
    }
    expect(corrected.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + Number(l.amountCents), 0)).toBe(70_000)
    expect(corrected.postedBy).toBe(U.ceo!.id)
  })

  it('reject (note ≥10) leaves the books alone; after a withdraw the entry is editable again', async () => {
    const e = await manual('fin', 30_000)
    const r = (await call('fin', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Wrong amount', description: 'Office rent', entryDate: at, lines: await two(31_000) })).json().request
    const rej = await call('ceo', 'POST', `/accounting/journal-requests/${r.id}/reject`, { note: 'The invoice says 30,000' }, A)
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().request.status).toBe('returned')
    expect(await reversalOf(e.reference)).toBeNull()
    expect(await prisma.journalEntry.count({ where: { reference: `manual:${r.id}` } })).toBe(0)
    expect((await call('fin', 'POST', `/accounting/journal-requests/${r.id}/withdraw`, {})).statusCode).toBe(200)
    expect((await call('fin', 'PATCH', `/accounting/journal/${e.id}/text`, { description: 'Office rent (checked)' })).statusCode).toBe(200)
  })

  it('cancel: finance → 202; the CEO approves → reversed', async () => {
    const e = await manual('fin', 20_000)
    expect((await call('finB', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Not ours' })).statusCode).toBe(404)
    const res = await call('fin', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Posted twice by mistake' })
    expect(res.statusCode, res.body).toBe(202)
    expect(res.json().request).toMatchObject({ kind: 'reverse', status: 'submitted', targetEntryId: e.id })
    expect(await reversalOf(e.reference)).toBeNull()
    const ok = await call('ceo', 'POST', `/accounting/journal-requests/${res.json().request.id}/approve`, {}, A)
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await reversalOf(e.reference))!.id).toBe(ok.json().entryId)
    const list = await call('fin', 'GET', '/accounting/journals?view=manual&q=Office%20rent&limit=200')
    expect((list.json().rows as Array<{ id: string; status: string }>).find((x) => x.id === e.id)!.status).toBe('reversed')
  })

  it('ENTRY_CHANGED when the entry moved after the request; the request stays submitted', async () => {
    const e = await manual('fin', 40_000)
    const r = (await call('fin', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Wrong amount', description: 'Office rent', entryDate: at, lines: await two(45_000) })).json().request
    await prisma.journalLine.update({ where: { id: e.lines[0]!.id }, data: { memo: 'changed underneath' } })
    const res = await call('ceo', 'POST', `/accounting/journal-requests/${r.id}/approve`, {}, A)
    expect([res.statusCode, code(res)]).toEqual([409, 'ENTRY_CHANGED'])
    expect((await prisma.journalRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('submitted')
    expect(await reversalOf(e.reference)).toBeNull()
    expect((await call('ceo', 'GET', `/accounting/journal-requests/${r.id}/diff`, undefined, A)).json().stale).toBe(true)
  })

  it('owner 2026-10-23 "only amount": finance moving the account, brand or date with the SAME amounts applies at once', async () => {
    const e = await manual('fin', 22_000)
    // Account 6010 → 6040, same amounts: applies at once (201), original reversed, nothing pending.
    const moved = await call('fin', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Wrong expense account', description: 'Office rent', entryDate: at, lines: [
      { accountId: await acct(A, '6040'), type: 'debit', amountCents: 22_000, conceptId: brandA }, { accountId: await acct(A, '1020'), type: 'credit', amountCents: 22_000 },
    ] })
    expect(moved.statusCode, moved.body).toBe(201)
    expect(moved.json().replaces.id).toBe(e.id)
    expect(await reversalOf(e.reference)).not.toBeNull()
    expect(await prisma.journalRequest.count({ where: { reverseEntryId: e.id } })).toBe(0)
    // A different day, same amounts: also at once.
    const day2 = new Date(new Date(at).getTime() - 86_400_000).toISOString()
    const redated = await call('fin', 'POST', `/accounting/journal/${moved.json().id}/amend`, { reason: 'Wrong day on it', description: 'Office rent', entryDate: day2, lines: [
      { accountId: await acct(A, '6040'), type: 'debit', amountCents: 22_000 }, { accountId: await acct(A, '1020'), type: 'credit', amountCents: 22_000 },
    ] })
    expect(redated.statusCode, redated.body).toBe(201)
    // Splitting a line (amounts change line by line) still waits for the CEO.
    const split = await call('fin', 'POST', `/accounting/journal/${redated.json().id}/amend`, { reason: 'Split across two', description: 'Office rent', entryDate: day2, lines: [
      { accountId: await acct(A, '6040'), type: 'debit', amountCents: 12_000 }, { accountId: await acct(A, '6010'), type: 'debit', amountCents: 10_000 },
      { accountId: await acct(A, '1020'), type: 'credit', amountCents: 22_000 },
    ] })
    expect(split.statusCode, split.body).toBe(202)
  })

  it('the CEO\'s own edit applies at once (201)', async () => {
    const e = await manual('fin', 15_000)
    const res = await call('ceo', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Wrong amount', description: 'Office rent', entryDate: at, lines: await two(16_000) }, A)
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().replaces.id).toBe(e.id)
  })
})

describe('registers', () => {
  const T = `${P}tok`
  const ids: Record<string, string> = {}
  beforeAll(async () => {
    const d = new Date(at)
    const mk = async (key: string, sourceType: string, debit: string, credit: string, cents: number, tenantId = A, conceptId: string | null = null) => {
      await postJournalEntry({ tenantId, sourceType, sourceId: `${P}-${key}`, description: `${T} ${key}`, entryDate: d, lines: [
        { accountCode: debit, type: 'debit', amountCents: cents, conceptId }, { accountCode: credit, type: 'credit', amountCents: cents },
      ] })
      ids[key] = (await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference: `${sourceType}:${P}-${key}` } })).id
    }
    await mk('pay', 'test.pay', '2010', '1020', 10_000)
    await mk('rcpt', 'test.rcpt', '1020', '4210', 20_000, A, brandA)
    await mk('xfer', 'test.xfer', '1020', '1010', 30_000)
    await mk('sale', 'order.complete', '1010', '4210', 40_000)
    await mk('accr', 'test.accr', '6010', '2010', 50_000, A, brandA)
    await mk('payB', 'test.pay', '2010', '1020', 10_000, B)
  })
  const idsOf = async (who: string, qs: string) => {
    const res = await call(who, 'GET', `/accounting/journals?q=${encodeURIComponent(T)}&${qs}`)
    expect(res.statusCode, res.body).toBe(200)
    return (res.json().rows as Array<{ id: string }>).map((r) => r.id).sort()
  }
  it('payment / receipt / all; transfers out; sales only on request; company B scoped', async () => {
    expect(await idsOf('fin', 'view=payment')).toEqual([ids.pay])
    expect(await idsOf('fin', 'view=receipt')).toEqual([ids.rcpt])
    expect(await idsOf('fin', 'view=receipt&includeSales=1')).toEqual([ids.rcpt, ids.sale].sort())
    expect(await idsOf('fin', 'view=all')).toEqual([ids.pay, ids.rcpt, ids.xfer, ids.sale, ids.accr].sort())
    expect(await idsOf('fin', 'view=manual')).toEqual([])
    expect(await idsOf('finB', 'view=all')).toEqual([ids.payB])
    expect(await idsOf('finB', 'view=payment')).toEqual([ids.payB])
  })
  it('filters: amount search, account, brand, min / max; row shape', async () => {
    expect(await idsOf('fin', 'view=all&accountCode=4210')).toEqual([ids.rcpt, ids.sale].sort())
    expect(await idsOf('fin', `view=all&brandId=${brandA}`)).toEqual([ids.rcpt, ids.accr].sort())
    expect(await idsOf('fin', 'view=all&minCents=30000&maxCents=40000')).toEqual([ids.xfer, ids.sale].sort())
    const amt = await call('fin', 'GET', '/accounting/journals?view=payment&q=100.00')
    expect((amt.json().rows as Array<{ id: string }>).map((r) => r.id)).toContain(ids.pay)
    const res = await call('fin', 'GET', `/accounting/journals?view=receipt&q=${encodeURIComponent(T)}`)
    const row = res.json().rows[0]
    expect(row).toMatchObject({ id: ids.rcpt, tenantId: A, totalCents: 20_000, moneyNetCents: 20_000, status: 'live', sourceType: 'test.rcpt', canTextEdit: false, canRequestChange: false })
    expect(row.moneyAccounts).toEqual([expect.objectContaining({ code: '1020', netCents: 20_000 })])
    expect(row.counterSummary).toContain('4210')
    expect(row.brands).toEqual([{ id: brandA, name: `${P} Cafe` }])
  })
  it('cursor pages without overlap; export', async () => {
    const p1 = await call('fin', 'GET', `/accounting/journals?view=all&q=${encodeURIComponent(T)}&limit=2`)
    expect(p1.json().hasMore).toBe(true)
    const p2 = await call('fin', 'GET', `/accounting/journals?view=all&q=${encodeURIComponent(T)}&limit=2&cursor=${p1.json().nextCursor}`)
    const p3 = await call('fin', 'GET', `/accounting/journals?view=all&q=${encodeURIComponent(T)}&limit=2&cursor=${p2.json().nextCursor}`)
    const all = [...p1.json().rows, ...p2.json().rows, ...p3.json().rows].map((r: { id: string }) => r.id)
    expect(new Set(all).size).toBe(5)
    expect(p3.json().hasMore).toBe(false)
    const csv = await call('fin', 'GET', `/accounting/journals?view=payment&q=${encodeURIComponent(T)}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain(`${T} pay`)
    const pdf = await call('fin', 'GET', `/accounting/journals?view=all&q=${encodeURIComponent(T)}&format=pdf`)
    expect(pdf.statusCode).toBe(200)
  })
})

describe('accounts: the statement is the account view', () => {
  it('pages with a running balance, filters by brand, carries row rights; company B gets 404; the picker searches', async () => {
    const acc = await acct(A, '6010')
    const range = `from=${day}&to=${day}`
    const full = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}`)
    expect(full.statusCode, full.body).toBe(200)
    const n = full.json().lines.length as number
    expect(n).toBeGreaterThan(2)
    const p1 = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&limit=2`)
    expect(p1.json().hasMore).toBe(true)
    expect(p1.json().closingCents).toBe(full.json().closingCents)
    const p2 = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&limit=2&cursor=${p1.json().nextCursor}`)
    expect(p2.json().pageOpeningCents).toBe(p1.json().lines[1].balanceCents)
    expect(p2.json().lines[0].balanceCents).toBe(full.json().lines[2].balanceCents)
    const line = full.json().lines.find((l: { sourceType: string; status: string }) => l.sourceType === 'manual' && l.status === 'live')
    expect(line).toMatchObject({ canTextEdit: true, canRequestChange: true, changeNeedsApproval: true })

    const branded = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&brandId=${brandA}`)
    expect(branded.statusCode, branded.body).toBe(200)
    expect(branded.json().lines.every((l: { conceptId: string | null }) => l.conceptId === brandA)).toBe(true)
    expect(branded.json().lines.length).toBeGreaterThan(0)
    expect((await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&brandId=${brandB}`)).statusCode).toBe(404)
    expect((await call('finB', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}`)).statusCode).toBe(404)
    const csv = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&format=csv&limit=2`)
    expect(csv.statusCode).toBe(200)

    const chart = await call('fin', 'GET', '/setup/chart-of-accounts?q=6010')
    expect(chart.statusCode, chart.body).toBe(200)
    const rows = chart.json() as Array<{ code: string; tenantId: string; companyName: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.tenantId === A && r.code.includes('6010'))).toBe(true)
    expect(rows[0]!.companyName).toBe(`${P} Foods`)
  })
})

describe('cancelled pairs are hidden from every account statement (owner, 2026-10-29)', () => {
  it('an entry and its cancellation in the window: hidden on screen and in exports, shown on request; balances unchanged', async () => {
    const e = await manual('ceo', 77_700, 'Cancelled pair check')
    const rev = await call('ceo', 'POST', `/accounting/journal/${e.id}/reverse`, { reason: 'Posted twice by mistake' })
    expect(rev.statusCode, rev.body).toBeLessThan(300)
    const reversal = await reversalOf(e.reference)
    expect(reversal).toBeTruthy()
    const range = `from=${day}&to=${fmtPktDate(new Date())}`
    for (const code6 of ['6010', '1020']) {
      const acc = await acct(A, code6)
      const hidden = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}`)
      const shown = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&showCancelled=1`)
      expect(hidden.statusCode, hidden.body).toBe(200)
      const ids = (r: typeof hidden) => (r.json().lines as Array<{ entryId: string }>).map((l) => l.entryId)
      expect(ids(hidden)).not.toContain(e.id)
      expect(ids(hidden)).not.toContain(reversal!.id)
      expect(ids(shown)).toContain(e.id)
      expect(ids(shown)).toContain(reversal!.id)
      expect(hidden.json().hiddenCancelled.entries).toBeGreaterThanOrEqual(2)
      expect(hidden.json().closingCents).toBe(shown.json().closingCents)
      // What is left out nets to zero: equal debits and credits.
      const dDr = shown.json().totals.debitCents - hidden.json().totals.debitCents
      const dCr = shown.json().totals.creditCents - hidden.json().totals.creditCents
      expect(dDr).toBe(dCr)
      expect(dDr).toBeGreaterThanOrEqual(77_700)
      const csvHidden = (await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&format=csv`)).body
      const csvShown = (await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${acc}&${range}&format=csv&showCancelled=1`)).body
      expect(csvHidden).not.toContain('Cancelled pair check')
      expect(csvShown).toContain('Cancelled pair check')
    }
  })
})

// Owner, 2026-10-23: "at Voucher it should give option to opt Payment voucher (PV), journal voucher (JV),
// Receiving voucher (RV) and adjustment voucher (AV)".
describe('voucher types on manual entries', () => {
  const post = async (who: string, voucherKind: string | undefined, lines: unknown[]) =>
    call(who, 'POST', '/accounting/journal', { description: `VT ${voucherKind ?? 'none'}`, entryDate: at, lines, ...(voucherKind ? { voucherKind } : {}) })
  const receipt = async (cents: number) => [
    { accountId: await acct(A, '1020'), type: 'debit' as const, amountCents: cents },
    { accountId: await acct(A, '4210'), type: 'credit' as const, amountCents: cents },
  ]
  const nonCash = async (cents: number) => [
    { accountId: await acct(A, '6010'), type: 'debit' as const, amountCents: cents },
    { accountId: await acct(A, '2010'), type: 'credit' as const, amountCents: cents },
  ]

  it('PV / RV / JV / AV number in their own series; none picked stays JV', async () => {
    const pv = await post('fin', 'PV', await two(700))
    expect(pv.statusCode, pv.body).toBe(201)
    expect((pv.json() as { voucherNo: string }).voucherNo).toMatch(/^PV-\d{5}$/)
    const rv = await post('fin', 'RV', await receipt(800))
    expect((rv.json() as { voucherNo: string }).voucherNo).toMatch(/^RV-\d{5}$/)
    const av = await post('fin', 'AV', await nonCash(900))
    expect((av.json() as { voucherNo: string }).voucherNo).toBe('AV-00001')
    const av2 = await post('fin', 'AV', await two(901))
    expect((av2.json() as { voucherNo: string }).voucherNo).toBe('AV-00002')
    expect(((await post('fin', undefined, await two(902))).json() as { voucherNo: string }).voucherNo).toMatch(/^JV-/)
    expect(((await post('fin', 'JV', await receipt(903))).json() as { voucherNo: string }).voucherNo).toMatch(/^JV-/)
  })

  it('PV must pay money out, RV must bring it in (422 VOUCHER_TYPE_MISMATCH); bad type 400', async () => {
    const r1 = await post('fin', 'PV', await nonCash(500))
    expect(r1.statusCode).toBe(422); expect(code(r1)).toBe('VOUCHER_TYPE_MISMATCH')
    const r2 = await post('fin', 'RV', await two(500))
    expect(r2.statusCode).toBe(422); expect(code(r2)).toBe('VOUCHER_TYPE_MISMATCH')
    expect((await post('fin', 'XV', await two(500))).statusCode).toBe(400)
  })

  it('changing only the type re-posts at once under the new series; a request keeps the type for the CEO', async () => {
    const e = (await post('fin', undefined, await two(1200))).json() as { id: string; lines: Array<{ accountId: string; type: string; amountCents: number; memo: string | null }> }
    const lines = e.lines.map((l) => ({ accountId: l.accountId, type: l.type, amountCents: Number(l.amountCents), ...(l.memo ? { memo: l.memo } : {}) }))
    const r = await call('fin', 'POST', `/accounting/journal/${e.id}/amend`, { reason: 'Should be a payment voucher', description: 'VT none', entryDate: at, lines, voucherKind: 'PV' })
    expect(r.statusCode, r.body).toBe(201)
    expect((r.json() as { voucherNo: string }).voucherNo).toMatch(/^PV-/)
    // An amount edit waits for the CEO and carries the type through the approval.
    const pvId = (r.json() as { id: string }).id
    const bigger = await two(1300)
    const q = await call('fin', 'POST', `/accounting/journal/${pvId}/amend`, { reason: 'Amount was wrong here', description: 'VT none', entryDate: at, lines: bigger, voucherKind: 'AV' })
    expect(q.statusCode, q.body).toBe(202)
    const req = (q.json() as { request: { id: string; voucherKind: string } }).request
    expect(req.voucherKind).toBe('AV')
    const ok = await call('ceo', 'POST', `/accounting/journal-requests/${req.id}/approve`, {}, A)
    expect(ok.statusCode, ok.body).toBe(200)
    const posted = await prisma.journalEntry.findUniqueOrThrow({ where: { id: (ok.json() as { entryId: string }).entryId } })
    expect(posted.voucherKind).toBe('AV')
  })

  it("company B never sees A's voucher series", async () => {
    const b = await call('finB', 'POST', '/accounting/journal', {
      description: 'B adjustment', entryDate: at, voucherKind: 'AV',
      lines: [{ accountId: await acct(B, '6010'), type: 'debit', amountCents: 50 }, { accountId: await acct(B, '2010'), type: 'credit', amountCents: 50 }],
    })
    expect(b.statusCode, b.body).toBe(201)
    expect((b.json() as { voucherNo: string }).voucherNo).toBe('AV-00001')
  })
})
