// The Trash bin — finance masters and the money-record findings (stream B6;
// modules/trash/providers/masters/finance.ts, SPEC §1b / §5 F1–F5, F10).
//
//   - Two companies: company B never sees or restores company A's finance
//     entries (404, empty list).
//   - F1: a voided sales-tax payment is kept in the Trash (snapshot with its
//     CPR), can never be purged (NOT_ERASABLE) and its prefill copy carries no
//     CPR / bank / posting.
//   - F4: reopening a period keeps the close (overrides + reasons) in the Trash.
//   - F2: undoing a card payout keeps it (with its days) in the Trash, and the
//     days are free to match again.
//   - F3: deleting a CapEx instalment keeps it in the Trash and writes the
//     audit row it never had.
//   - An allocation rule with runs soft-deletes (no FK 500), is hidden from the
//     list, is never erasable, and a restore with a live rule on the same
//     account answers 409.
//   - A CapEx line restore under a trashed project → PARENT_IN_TRASH; after the
//     project, the line comes back with its quotes.
//   - A dismissed exception reopens; an OpEx line switches back on.
//   - The trial balance is unchanged across delete / restore / copy.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { trashProvider } = await import('../src/modules/trash/registry.js')
const { TRASH_FINANCE } = await import('../src/modules/trash/providers/masters/finance.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { financePlanningRoutes } = await import('../src/modules/financePlanning/routes.js')
const { allocationRoutes } = await import('../src/modules/allocations/routes.js')
const { opexRoutes } = await import('../src/modules/opex/routes.js')
const { crosschecksRoutes } = await import('../src/modules/crosschecks/routes.js')
const { tipPoolRoutes } = await import('../src/modules/tipPools/routes.js')
const { undoCardSettlement } = await import('../src/modules/reconciliation/cardPayouts.js')

const stamp = Date.now()
const P = `trf${stamp}`
let app: FastifyInstance
const T = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
let bankA = ''

const pktIso = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const TODAY = pktIso(new Date())
const M2 = TODAY.slice(0, 7)
const M1 = (() => {
  const [y, m] = M2.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
})()

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@trf.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const headers = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const call = (key: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { ...headers(key), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
const openEntry = (type: string, id: string) =>
  prisma.trashEntry.findFirst({ where: { entityType: type, entityId: id, restoredAt: null, purgedAt: null } })

/** The company's whole ledger in one comparable value (entries, debits, credits, per-account balances). */
async function ledgerPrint(tenantId: string) {
  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId } },
    select: { type: true, amountCents: true, account: { select: { code: true } } },
  })
  const byCode = new Map<string, number>()
  let dr = 0, cr = 0
  for (const l of lines) {
    const a = Number(l.amountCents)
    if (l.type === 'debit') dr += a; else cr += a
    byCode.set(l.account.code, (byCode.get(l.account.code) ?? 0) + (l.type === 'debit' ? a : -a))
  }
  const entries = await prisma.journalEntry.count({ where: { tenantId } })
  return { entries, dr, cr, balances: [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b)) }
}

beforeAll(async () => {
  for (const co of ['A', 'B'] as const) {
    T[co] = (await prisma.tenant.create({ data: { name: `${P} Co ${co}`, slug: `${P}-${co.toLowerCase()}` } })).id
    await ensureChartOfAccounts(T[co])
  }
  bankA = (await prisma.bankAccount.create({ data: { tenantId: T.A, name: `${P} A Operating`, accountCode: '1020' } })).id
  await mkUser('ceo', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('ceoB', 'admin', [T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(financePlanningRoutes, { prefix: '/finance' })
    await api.register(allocationRoutes, { prefix: '/allocations' })
    await api.register(opexRoutes, { prefix: '/opex' })
    await api.register(crosschecksRoutes, { prefix: '/crosschecks' })
    await api.register(tipPoolRoutes, { prefix: '/tip-pools' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('registry', () => {
  it('every finance master type is registered once, with a known module', () => {
    for (const key of Object.values(TRASH_FINANCE)) expect(trashProvider(key), key).not.toBeNull()
  })
})

// ── CapEx: project / line / quote / instalment ───────────────────────────────

describe('CapEx', () => {
  let projectId = '', lineId = '', quoteId = '', payId = '', before: Awaited<ReturnType<typeof ledgerPrint>>
  beforeAll(async () => {
    before = await ledgerPrint(T.A)
    const project = await prisma.capexProject.create({ data: { tenantId: T.A, name: `${P} Kitchen` } })
    projectId = project.id
    const line = await prisma.capexLine.create({ data: { projectId, scope: 'BOH', item: `${P} Oven`, unitCostCents: 500_000 } })
    lineId = line.id
    quoteId = (await prisma.capexQuote.create({ data: { lineId, vendor: 'Oven Co', totalCents: 480_000, isWinner: true } })).id
    const line2 = await prisma.capexLine.create({ data: { projectId, scope: 'BOH', item: `${P} Fryer`, unitCostCents: 200_000 } })
    payId = (await prisma.capexPayment.create({ data: { lineId: line2.id, label: 'deposit', amountCents: 50_000 } })).id
  })

  it('B cannot delete A\'s line (404)', async () => {
    expect((await call('finB', 'DELETE', `/finance/capex/lines/${lineId}`)).statusCode).toBe(404)
  })

  it('a deleted line goes to the Trash WITH its quote; B neither sees nor restores it', async () => {
    expect((await call('finA', 'DELETE', `/finance/capex/lines/${lineId}?reason=${encodeURIComponent('wrong oven')}`)).statusCode).toBe(204)
    expect(await prisma.capexLine.findUnique({ where: { id: lineId } })).toBeNull()
    expect(await prisma.capexQuote.findUnique({ where: { id: quoteId } })).toBeNull()
    const e = await openEntry('capex_line', lineId)
    expect(e).toMatchObject({ tenantId: T.A, deletedById: U.finA!.id, reason: 'wrong oven', parentType: 'capex_project', parentId: projectId })
    const listB = (await call('finB', 'GET', '/trash?type=capex_line')).json() as { items: unknown[] }
    expect(listB.items).toEqual([])
    expect((await call('finB', 'POST', `/trash/capex_line/${lineId}/restore`, {})).statusCode).toBe(404)
    const listA = (await call('finA', 'GET', '/trash?type=capex_line')).json() as { items: Array<{ id: string }> }
    expect(listA.items.map((i) => i.id)).toContain(lineId)
  })

  it('a line under a trashed project answers PARENT_IN_TRASH; after the project it comes back with its quote', async () => {
    // The project still has a line (the fryer); deleting it moves it to the Trash.
    expect((await call('finA', 'DELETE', `/finance/capex/${projectId}`)).statusCode).toBe(204)
    expect((await prisma.capexProject.findUnique({ where: { id: projectId } }))!.deletedAt).not.toBeNull()
    const r1 = await call('finA', 'POST', `/trash/capex_line/${lineId}/restore`, {})
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('PARENT_IN_TRASH')
    expect(r1.json().error.details.parent).toMatchObject({ type: 'capex_project', id: projectId })
    expect((await call('finB', 'POST', `/trash/capex_project/${projectId}/restore`, {})).statusCode).toBe(404)
    expect((await call('finA', 'POST', `/trash/capex_project/${projectId}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.capexProject.findUnique({ where: { id: projectId } }))!.deletedAt).toBeNull()
    const r2 = await call('finA', 'POST', `/trash/capex_line/${lineId}/restore`, {})
    expect(r2.statusCode).toBe(200)
    expect(await prisma.capexLine.findUnique({ where: { id: lineId } })).not.toBeNull()
    // The whole line comes back as it was, winner included.
    expect((await prisma.capexQuote.findUnique({ where: { id: quoteId } }))!.isWinner).toBe(true)
  })

  it('F3: deleting an instalment keeps it in the Trash (never restored, never erased) and audits it', async () => {
    expect((await call('finA', 'DELETE', `/finance/capex/payments/${payId}?reason=${encodeURIComponent('entered twice')}`)).statusCode).toBe(204)
    expect(await prisma.capexPayment.findUnique({ where: { id: payId } })).toBeNull()
    const e = await openEntry('capex_payment', payId)
    expect(e).toMatchObject({ tenantId: T.A, deletedById: U.finA!.id, reason: 'entered twice' })
    expect((e!.snapshot as { row: { amountCents: number } }).row.amountCents).toBe(50_000)
    const a = await prisma.auditLog.findFirst({ where: { action: 'capex.payment.delete', entityId: payId } })
    expect(a).toMatchObject({ category: 'accounting', tenantId: T.A, userId: U.finA!.id })
    if (trashProvider('capex_payment')) {
      expect((await call('finA', 'POST', `/trash/capex_payment/${payId}/restore`, {})).statusCode).toBe(422)
      const purge = await call('ceo', 'DELETE', `/trash/capex_payment/${payId}?reason=${encodeURIComponent('clean the trash please')}`)
      expect(purge.statusCode).toBe(409)
      expect(purge.json().error.code).toBe('NOT_ERASABLE')
    }
  })

  it('a line whose posted instalment was deleted earlier is never erasable', async () => {
    const project = await prisma.capexProject.create({ data: { tenantId: T.A, name: `${P} Fit-out` } })
    const line = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'FOH', item: `${P} Booths`, unitCostCents: 300_000 } })
    const pay = await prisma.capexPayment.create({ data: { lineId: line.id, label: 'deposit', amountCents: 40_000 } })
    await postJournalEntry({
      tenantId: T.A, sourceType: 'capex.payment', sourceId: pay.id, description: 'capex deposit', postedBy: 'test',
      entryDate: new Date(),
      lines: [
        { accountCode: '1340', type: 'debit', amountCents: 40_000 },
        { accountCode: '1020', type: 'credit', amountCents: 40_000 },
      ],
    })
    // The instalment goes (its posting reversed); the line has nothing live left.
    expect((await call('finA', 'DELETE', `/finance/capex/payments/${pay.id}`)).statusCode).toBe(204)
    expect((await call('finA', 'DELETE', `/finance/capex/lines/${line.id}`)).statusCode).toBe(204)
    expect(((await openEntry('capex_line', line.id))!.meta as { everPosted?: boolean }).everPosted).toBe(true)
    const purge = await call('ceo', 'DELETE', `/trash/capex_line/${line.id}?reason=${encodeURIComponent('clean the trash please')}`)
    expect(purge.statusCode).toBe(409)
    expect(purge.json().error.code).toBe('NOT_ERASABLE')
    before = await ledgerPrint(T.A)
  })

  it('a quote comes back on its line; nothing touched the books', async () => {
    expect((await call('finA', 'DELETE', `/finance/capex/quotes/${quoteId}`)).statusCode).toBe(204)
    expect((await call('finA', 'POST', `/trash/capex_quote/${quoteId}/restore`, {})).statusCode).toBe(200)
    // A quote restored on its own never takes the winner back (the line decides).
    expect((await prisma.capexQuote.findUnique({ where: { id: quoteId } }))!.isWinner).toBe(false)
    expect(await ledgerPrint(T.A)).toEqual(before)
  })
})

// ── F1: sales-tax payment void ───────────────────────────────────────────────

describe('F1: a voided sales-tax payment', () => {
  let payId = ''
  let afterVoid: Awaited<ReturnType<typeof ledgerPrint>>
  beforeAll(async () => {
    await postJournalEntry({
      tenantId: T.A, sourceType: 'test.sale', sourceId: `${P}-sale`, description: 'sale', postedBy: 'test',
      entryDate: new Date(`${M1}-10T10:00:00+05:00`),
      lines: [
        { accountCode: '1010', type: 'debit', amountCents: 15_000 },
        { accountCode: '4090', type: 'credit', amountCents: 13_500 },
        { accountCode: '2032', type: 'credit', amountCents: 1_500 },
      ],
    })
    const res = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'srb', period: M1, paidCents: 1_500, paidAt: `${M2}-01`, method: 'bank_transfer', bankAccountId: bankA, cprNumber: `CPR-${P}`,
    })
    expect(res.statusCode).toBe(201)
    payId = (res.json() as { id: string }).id
    expect((await call('finB', 'POST', `/accounting/sales-tax-return/payments/${payId}/void`, { reason: 'not ours at all' })).statusCode).toBe(404)
    const v = await call('finA', 'POST', `/accounting/sales-tax-return/payments/${payId}/void`, { reason: 'paid to the wrong period' })
    expect(v.statusCode).toBe(200)
    afterVoid = await ledgerPrint(T.A)
  })

  it('is kept in the Trash with its CPR, in the payment\'s company, with who and why', async () => {
    expect(await prisma.salesTaxPayment.findUnique({ where: { id: payId } })).toBeNull()
    const e = await openEntry('sales_tax_payment', payId)
    expect(e).toMatchObject({ tenantId: T.A, deletedById: U.finA!.id, reason: 'paid to the wrong period' })
    const row = (e!.snapshot as { model: string; row: Record<string, unknown> })
    expect(row.model).toBe('SalesTaxPayment')
    expect(row.row.cprNumber).toBe(`CPR-${P}`)
    expect(row.row.paidCents).toBe(1_500)
    // The reversal was posted in the same transaction (books balance).
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A, reference: { startsWith: `salestax.payment.reversal:${payId}` } } })).toBe(1)
    expect(afterVoid.dr).toBe(afterVoid.cr)
  })

  it.skipIf(!trashProvider('sales_tax_payment'))('B never sees it; the CEO cannot purge it; its copy carries no CPR or posting', async () => {
    const listB = (await call('finB', 'GET', '/trash?type=sales_tax_payment')).json() as { items: unknown[] }
    expect(listB.items ?? []).toEqual([])
    expect((await call('finB', 'GET', `/trash/sales_tax_payment/${payId}`)).statusCode).toBe(404)
    const listA = (await call('finA', 'GET', '/trash?type=sales_tax_payment')).json() as { items: Array<{ id: string }> }
    expect(listA.items.map((i) => i.id)).toContain(payId)
    const purge = await call('ceo', 'DELETE', `/trash/sales_tax_payment/${payId}?reason=${encodeURIComponent('clean the trash please')}`)
    expect(purge.statusCode).toBe(409)
    expect(purge.json().error.code).toBe('NOT_ERASABLE')
    expect((await call('finA', 'POST', `/trash/sales_tax_payment/${payId}/restore`, {})).statusCode).toBe(422)
    const copy = await call('finA', 'POST', `/trash/sales_tax_payment/${payId}/copy`, {})
    expect(copy.statusCode).toBe(200)
    const payload = JSON.stringify(copy.json())
    expect(payload).not.toContain(`CPR-${P}`)
    expect(payload).not.toMatch(/journalEntryId|cprNumber"\s*:\s*"/)
    expect(await ledgerPrint(T.A)).toEqual(afterVoid)
  })
})

// ── F4: period reopen ────────────────────────────────────────────────────────

describe('F4: reopening a period', () => {
  it('keeps the close (overrides and reasons) in the Trash; B sees nothing of it', async () => {
    const lock = await prisma.periodLock.create({
      data: {
        tenantId: T.A, lockedThrough: new Date('2020-01-31T18:59:59Z'), lockedBy: U.ceo!.id, note: `${P} Jan close`,
        overrides: { keys: ['cod_with_rider'] }, overrideReason: 'riders paid in on the 2nd',
      },
    })
    const r = await call('ceo', 'POST', '/accounting/period-close/reopen', { reason: 'late supplier bill' })
    expect(r.statusCode).toBe(200)
    expect(await prisma.periodLock.findUnique({ where: { id: lock.id } })).toBeNull()
    const e = await openEntry('period_lock', lock.id)
    expect(e).toMatchObject({ tenantId: T.A, deletedById: U.ceo!.id, reason: 'late supplier bill' })
    const row = (e!.snapshot as { row: Record<string, unknown> }).row
    expect(row).toMatchObject({ overrideReason: 'riders paid in on the 2nd', note: `${P} Jan close`, overrides: { keys: ['cod_with_rider'] } })
    if (trashProvider('period_lock')) {
      expect((await call('ceoB', 'GET', `/trash/period_lock/${lock.id}`)).statusCode).toBe(404)
      const purge = await call('ceo', 'DELETE', `/trash/period_lock/${lock.id}?reason=${encodeURIComponent('clean the trash please')}`)
      expect(purge.json().error.code).toBe('NOT_ERASABLE')
    }
  })
})

// ── F2: card payout undo ─────────────────────────────────────────────────────

describe('F2: undoing a card payout', () => {
  it('keeps the payout and its days in the Trash; the days are free again; the reversal balances', async () => {
    const st = await prisma.cardSettlement.create({
      data: {
        tenantId: T.A, bankAccountId: bankA, statementLineId: `${P}-line`, grossCents: 10_000, feeCents: 200, netCents: 9_800,
        dayFrom: '2026-09-01', dayTo: '2026-09-02', status: 'confirmed',
        days: { create: [
          { tenantId: T.A, day: '2026-09-01', grossCents: 6_000 },
          { tenantId: T.A, day: '2026-09-02', grossCents: 4_000 },
        ] },
      },
    })
    const posted = await postJournalEntry({
      tenantId: T.A, sourceType: 'test.cardpayout', sourceId: st.id, description: 'payout', postedBy: 'test',
      entryDate: new Date('2026-09-03T10:00:00+05:00'),
      lines: [
        { accountCode: '1020', type: 'debit', amountCents: 9_800 },
        { accountCode: '6080', type: 'debit', amountCents: 200 },
        { accountCode: '1030', type: 'credit', amountCents: 10_000 },
      ],
    })
    const entryId = (posted as { entryId?: string; id?: string }).entryId ?? (posted as { id?: string }).id
    await prisma.cardSettlement.update({ where: { id: st.id }, data: { journalEntryId: entryId } })
    const before = await ledgerPrint(T.A)

    await expect(undoCardSettlement({ settlementId: st.id, tenantId: T.B, actorId: U.finB!.id, reason: 'not ours' })).rejects.toThrow()
    const out = await undoCardSettlement({ settlementId: st.id, tenantId: T.A, actorId: U.finA!.id, reason: 'wrong bank line' })
    expect(out.days).toEqual(['2026-09-01', '2026-09-02'])
    expect(await prisma.cardSettlement.findUnique({ where: { id: st.id } })).toBeNull()

    const e = await openEntry('card_settlement', st.id)
    expect(e).toMatchObject({ tenantId: T.A, deletedById: U.finA!.id, reason: 'wrong bank line' })
    const snap = e!.snapshot as { row: Record<string, unknown>; children: Record<string, Array<Record<string, unknown>>> }
    expect(snap.row.netCents).toBe(9_800)
    expect(snap.children.CardSettlementDay!.map((d) => d.day).sort()).toEqual(['2026-09-01', '2026-09-02'])

    // The days are free: another payout can claim them.
    const again = await prisma.cardSettlement.create({
      data: {
        tenantId: T.A, bankAccountId: bankA, statementLineId: `${P}-line-2`, grossCents: 10_000, feeCents: 200, netCents: 9_800,
        dayFrom: '2026-09-01', dayTo: '2026-09-02', status: 'confirmed',
        days: { create: [{ tenantId: T.A, day: '2026-09-01', grossCents: 6_000 }, { tenantId: T.A, day: '2026-09-02', grossCents: 4_000 }] },
      },
    })
    expect(again.id).toBeTruthy()

    // One reversal, balanced; nothing else moved.
    const after = await ledgerPrint(T.A)
    expect(after.entries).toBe(before.entries + 1)
    expect(after.dr).toBe(after.cr)
    expect(after.balances.find(([c]) => c === '1030')![1]).toBe((before.balances.find(([c]) => c === '1030')?.[1] ?? 0) + 10_000)
  })
})

// ── Allocation rule ──────────────────────────────────────────────────────────

describe('allocation rule with runs', () => {
  let ruleId = ''
  beforeAll(async () => {
    const brand = await prisma.concept.create({ data: { name: `${P} Brand`, slug: `${P}-brand`, type: 'restaurant', tenantId: T.A } })
    const rule = await prisma.costAllocationRule.create({
      data: { tenantId: T.A, name: `${P} rent split`, sourceAccountCode: '6010', driver: 'fixed_pct', weights: { create: [{ conceptId: brand.id, weightBps: 10_000 }] } },
    })
    ruleId = rule.id
    await prisma.costAllocationRun.create({
      data: { tenantId: T.A, ruleId, periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'), totalAmountCents: 100_000 },
    })
  })

  it('B cannot delete it (404); A soft-deletes it (no 500) and the list hides it', async () => {
    expect((await call('ceoB', 'DELETE', `/allocations/rules/${ruleId}`)).statusCode).toBe(404)
    const before = await ledgerPrint(T.A)
    expect((await call('ceo', 'DELETE', `/allocations/rules/${ruleId}`)).statusCode).toBe(204)
    const row = await prisma.costAllocationRule.findUnique({ where: { id: ruleId } })
    expect(row!.deletedAt).not.toBeNull()
    expect(row!.isActive).toBe(false)
    const list = (await call('finA', 'GET', '/allocations/rules')).json() as Array<{ id: string }>
    expect(list.map((r) => r.id)).not.toContain(ruleId)
    expect((await call('ceo', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-09-01', periodEnd: '2026-09-30' })).statusCode).toBe(404)
    expect(await openEntry('cost_allocation_rule', ruleId)).toMatchObject({ tenantId: T.A, deletedById: U.ceo!.id })
    expect(await ledgerPrint(T.A)).toEqual(before)
  })

  it('is never erasable (it ran); a live rule on the same account blocks the restore', async () => {
    const purge = await call('ceo', 'DELETE', `/trash/cost_allocation_rule/${ruleId}?reason=${encodeURIComponent('clean the trash please')}`)
    expect(purge.statusCode).toBe(409)
    expect(purge.json().error.code).toBe('NOT_ERASABLE')
    // A new rule for 6010 while the old one is in the Trash (partial unique).
    const brand = await prisma.concept.findFirstOrThrow({ where: { slug: `${P}-brand` } })
    const created = await call('ceo', 'POST', '/allocations/rules', {
      name: `${P} new split`, sourceAccountCode: '6010', driver: 'fixed_pct', weights: [{ conceptId: brand.id, weightBps: 10_000 }],
    })
    expect(created.statusCode).toBe(201)
    const newId = (created.json() as { id: string }).id
    expect(newId).not.toBe(ruleId)
    // Saving again updates the live rule, never the trashed one.
    const again = await call('ceo', 'POST', '/allocations/rules', {
      name: `${P} new split v2`, sourceAccountCode: '6010', driver: 'fixed_pct', weights: [{ conceptId: brand.id, weightBps: 10_000 }],
    })
    expect((again.json() as { id: string }).id).toBe(newId)
    const clash = await call('ceo', 'POST', `/trash/cost_allocation_rule/${ruleId}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.details).toMatchObject({ field: 'sourceAccountCode', value: '6010', renamable: false })
    // Finance can list it but only the CEO restores (the delete was the CEO's).
    expect((await call('finA', 'POST', `/trash/cost_allocation_rule/${ruleId}/restore`, {})).statusCode).toBe(403)
    // Delete the new one, then the old one comes back switched on.
    expect((await call('ceo', 'DELETE', `/allocations/rules/${newId}`)).statusCode).toBe(204)
    expect((await call('ceo', 'POST', `/trash/cost_allocation_rule/${ruleId}/restore`, {})).statusCode).toBe(200)
    const row = await prisma.costAllocationRule.findUnique({ where: { id: ruleId } })
    expect(row).toMatchObject({ deletedAt: null, isActive: true })
    // The newer one is erasable (never ran).
    expect((await call('ceo', 'DELETE', `/trash/cost_allocation_rule/${newId}?reason=${encodeURIComponent('made by mistake today')}`)).statusCode).toBe(204)
    expect(await prisma.costAllocationRule.findUnique({ where: { id: newId } })).toBeNull()
  })
})

// ── OpEx line / exception flag (status types) ───────────────────────────────

describe('status types', () => {
  it('an OpEx line switches back on; it is never erasable', async () => {
    const cat = await prisma.opexCategory.create({ data: { tenantId: T.A, name: `${P} Utilities` } })
    const line = await prisma.opexLine.create({ data: { categoryId: cat.id, name: `${P} KE bill`, amountCents: 50_000 } })
    expect((await call('finB', 'DELETE', `/opex/lines/${line.id}`)).statusCode).toBe(404)
    expect((await call('finA', 'DELETE', `/opex/lines/${line.id}`)).statusCode).toBe(204)
    expect((await prisma.opexLine.findUnique({ where: { id: line.id } }))!.isActive).toBe(false)
    const purge = await call('ceo', 'DELETE', `/trash/opex_line/${line.id}?reason=${encodeURIComponent('clean the trash please')}`)
    expect(purge.json().error.code).toBe('NOT_ERASABLE')
    expect((await call('finB', 'POST', `/trash/opex_line/${line.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('finA', 'POST', `/trash/opex_line/${line.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.opexLine.findUnique({ where: { id: line.id } }))!.isActive).toBe(true)
  })

  it('a category with lines comes back active and is never erasable', async () => {
    const cat = await prisma.opexCategory.create({ data: { tenantId: T.A, name: `${P} Rent` } })
    await prisma.opexLine.create({ data: { categoryId: cat.id, name: `${P} Office rent`, amountCents: 90_000 } })
    expect((await call('finA', 'DELETE', `/opex/categories/${cat.id}`)).statusCode).toBe(204)
    const purge = await call('ceo', 'DELETE', `/trash/opex_category/${cat.id}?reason=${encodeURIComponent('clean the trash please')}`)
    expect(purge.json().error.code).toBe('NOT_ERASABLE')
    expect((await call('finA', 'POST', `/trash/opex_category/${cat.id}/restore`, {})).statusCode).toBe(200)
    expect(await prisma.opexCategory.findUnique({ where: { id: cat.id } })).toMatchObject({ deletedAt: null, isActive: true })
  })

  it('a dismissed exception reopens; only the CEO restores it', async () => {
    const flag = await prisma.exceptionFlag.create({
      data: { tenantId: T.A, kind: 'cash_variance', title: `${P} drawer short`, description: 'x', status: 'open' },
    })
    expect((await call('ceoB', 'DELETE', `/crosschecks/exceptions/${flag.id}`)).statusCode).toBe(404)
    expect((await call('ceo', 'DELETE', `/crosschecks/exceptions/${flag.id}`)).statusCode).toBe(204)
    expect((await prisma.exceptionFlag.findUnique({ where: { id: flag.id } }))!.status).toBe('dismissed')
    const listA = (await call('finA', 'GET', '/trash?type=exception_flag')).json() as { items: Array<{ id: string; canRestore: boolean }> }
    const item = listA.items.find((i) => i.id === flag.id)!
    expect(item.canRestore).toBe(false)
    expect((await call('finA', 'POST', `/trash/exception_flag/${flag.id}/restore`, {})).statusCode).toBe(403)
    expect((await call('ceo', 'POST', `/trash/exception_flag/${flag.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.exceptionFlag.findUnique({ where: { id: flag.id } }))!.status).toBe('open')
  })
})

// ── Tip pool draft ───────────────────────────────────────────────────────────

describe('tip pool draft', () => {
  it('goes to the Trash with its members and comes back whole; a posted pool stays', async () => {
    const pool = await prisma.tipPool.create({
      data: {
        tenantId: T.A, name: `${P} Sat dinner`, periodStart: new Date('2026-09-05'), periodEnd: new Date('2026-09-06'), totalTipsCents: 3_000,
        members: { create: [{ userId: U.finA!.id, userName: 'Fin A', hoursWorked: 6, shareUnits: 6 }] },
      },
    })
    expect((await call('ceoB', 'DELETE', `/tip-pools/${pool.id}`)).statusCode).toBe(404)
    expect((await call('ceo', 'DELETE', `/tip-pools/${pool.id}`)).statusCode).toBe(204)
    expect(await prisma.tipPool.findUnique({ where: { id: pool.id } })).toBeNull()
    expect(await openEntry('tip_pool', pool.id)).toMatchObject({ tenantId: T.A, deletedById: U.ceo!.id })
    expect((await call('ceoB', 'POST', `/trash/tip_pool/${pool.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ceo', 'POST', `/trash/tip_pool/${pool.id}/restore`, {})).statusCode).toBe(200)
    const back = await prisma.tipPool.findUnique({ where: { id: pool.id }, include: { members: true } })
    expect(back).toMatchObject({ tenantId: T.A, status: 'draft', totalTipsCents: 3_000 })
    expect(back!.members.map((m) => m.userId)).toEqual([U.finA!.id])

    const posted = await prisma.tipPool.create({
      data: { tenantId: T.A, name: `${P} posted`, periodStart: new Date('2026-09-07'), periodEnd: new Date('2026-09-08'), status: 'posted' },
    })
    const r = await call('ceo', 'DELETE', `/tip-pools/${posted.id}`)
    expect(r.statusCode).toBe(409)
    expect(await openEntry('tip_pool', posted.id)).toBeNull()
  })
})
