// Stock and CapEx lines on a direct petty-cash spend (wave B, W3).
//
//   - A stock line brings the goods in as ONE settled goods receipt (system
//     supplier 'Cash purchases', FIFO lots at the amount paid) and the spend's
//     own entry books Dr 1210 / 1220 / 1230 by the item's class / Cr 1011.
//   - A capex line is paid through its CapEx line (Dr 1340 / Cr 1011, its own
//     'capex.payment' entry, once); the spend's entry leaves it out.
//   - Stock lines: cash keepers or roles with the inventory module only (403);
//     never on a spend that pays a supplier bill (422); another company's item
//     or CapEx line → 422; another company's box → 404.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { recordPettyCashSpendTx } from '../src/modules/trustops/pettyCash.js'
import { pettyCashTieOut } from '../src/modules/accounting/pettyCashPosting.js'

const P = `pcl${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const item: Record<string, string> = {}
const capex: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@pcl.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const spend = (key: string, boxId: string, amountCents: number, lines: unknown[]) =>
  call(key, 'POST', '/trustops/petty-cash/movements', { boxId, type: 'spend', amountCents, reason: 'Market run', lines })
async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId: T.A, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Lines Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Lines Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  await mkUser('finA', 'finance', [T.A])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('finB', 'finance', [T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }) }, { prefix: '/api/v1' })
  await app.ready()

  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Front box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['kitchen'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Kitchen box', custodianId: U['cookA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['B'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['finB']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  for (const [b, who] of [['A', 'finA'], ['kitchen', 'finA'], ['B', 'finB']] as const) {
    const r = await call(who, 'POST', '/trustops/petty-cash/movements', { boxId: box[b], type: 'topup', amountCents: 300_000, reason: 'Float', source: 'garibsons' })
    expect(r.statusCode, r.body).toBe(201)
  }
  item['tomato'] = (await prisma.inventoryItem.create({ data: { name: `${P} Tomato`, unit: 'kg', tenantId: T.A, currentStock: 0, category: 'produce' } })).id
  item['juice'] = (await prisma.inventoryItem.create({ data: { name: `${P} Juice`, unit: 'l', tenantId: T.A, currentStock: 0, category: 'beverage' } })).id
  item['B'] = (await prisma.inventoryItem.create({ data: { name: `${P} B Tomato`, unit: 'kg', tenantId: T.B, currentStock: 0, category: 'produce' } })).id
  const projA = (await prisma.capexProject.create({ data: { tenantId: T.A, name: `${P} fit-out` } })).id
  capex['A'] = (await prisma.capexLine.create({ data: { projectId: projA, scope: 'Equipment', item: 'Blender', unitCostCents: 500_000 } })).id
  const projB = (await prisma.capexProject.create({ data: { tenantId: T.B, name: `${P} B fit-out` } })).id
  capex['B'] = (await prisma.capexLine.create({ data: { projectId: projB, scope: 'Equipment', item: 'B blender', unitCostCents: 500_000 } })).id
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('stock lines on a direct box spend', () => {
  it('a keeper: settled receipt + lots, and Dr 1210 / 1220 / 6170 / Cr 1011 in ONE entry', async () => {
    const float = await floatOf(box['A']!)
    const r = await spend('finA', box['A']!, 9_000, [
      { kind: 'stock', inventoryItemId: item['tomato'], quantity: 3, unit: 'kg', amountCents: 4_500, description: 'Tomatoes' },
      { kind: 'stock', inventoryItemId: item['juice'], quantity: 2, unit: 'l', amountCents: 2_500, description: 'Juice' },
      { kind: 'expense', categoryKey: 'office', amountCents: 2_000, description: 'Pens' },
    ])
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().movement.id as string
    expect(await entry(`pettycash.spend:${id}`)).toEqual([['1011', 'credit', 9_000], ['1210', 'debit', 4_500], ['1220', 'debit', 2_500], ['6170', 'debit', 2_000]])
    expect(await floatOf(box['A']!)).toBe(float - 9_000)
    const gr = await prisma.goodsReceipt.findFirstOrThrow({ where: { settledById: id }, include: { lines: true } })
    expect(gr).toMatchObject({ tenantId: T.A, settledByType: 'petty_cash_movement', settledAccountCode: '1011' })
    const lines = await prisma.pettyCashSpendLine.findMany({ where: { movementId: id }, orderBy: { createdAt: 'asc' } })
    expect(lines.map((l) => [l.kind, l.accountCode, !!l.receiptLineId, l.quantity, l.unit])).toEqual([
      ['stock', '1210', true, 3, 'kg'], ['stock', '1220', true, 2, 'l'], ['expense', '6170', false, null, null],
    ])
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item['tomato'] } })).currentStock).toBe(3)
  })

  it('a custodian without the inventory module → 403; a cook (inventory module) may', async () => {
    const no = await spend('cashA', box['A']!, 1_000, [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 1, unit: 'kg', amountCents: 1_000, description: 'Tomatoes' }])
    expect(no.statusCode).toBe(403)
    expect(no.json().error.code).toBe('STOCK_LINES_NOT_ALLOWED')
    const yes = await spend('cookA', box['kitchen']!, 1_000, [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 500, unit: 'g', amountCents: 1_000, description: 'Tomatoes' }])
    expect(yes.statusCode, yes.body).toBe(201)
    expect(await entry(`pettycash.spend:${yes.json().movement.id}`)).toEqual([['1011', 'credit', 1_000], ['1210', 'debit', 1_000]])
  })

  it('a stock line on a bill spend → 422; another company\'s item → 422; another company\'s box → 404', async () => {
    await expect(prisma.$transaction((tx) => recordPettyCashSpendTx(tx, {
      box: { id: box['A']! }, amountCents: 1_000, reason: 'Bill', createdById: U['finA']!.id, nature: 'bill', supplierPaymentId: 'sp-x',
      lines: [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 1, unit: 'kg', amountCents: 1_000, description: 'x' }],
    }))).rejects.toMatchObject({ code: 'STOCK_ON_BILL_SPEND', statusCode: 422 })
    const foreign = await spend('finA', box['A']!, 1_000, [{ kind: 'stock', inventoryItemId: item['B'], quantity: 1, unit: 'kg', amountCents: 1_000, description: 'x' }])
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
    const unit = await spend('finA', box['A']!, 1_000, [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 1, unit: 'pcs', amountCents: 1_000, description: 'x' }])
    expect(unit.json().error.code).toBe('UNIT_MISMATCH')
    expect((await spend('finA', box['B']!, 1_000, [{ kind: 'expense', categoryKey: 'office', amountCents: 1_000, description: 'x' }])).statusCode).toBe(404)
    expect(await prisma.goodsReceipt.count({ where: { tenantId: T.B } })).toBe(0)
  })
})

describe('capex lines on a direct box spend', () => {
  it('the CapEx payment books Dr 1340 / Cr 1011 once; the spend\'s entry leaves it out', async () => {
    const float = await floatOf(box['A']!)
    const r = await spend('finA', box['A']!, 6_000, [
      { kind: 'capex', capexLineId: capex['A'], amountCents: 5_000, description: 'Blender' },
      { kind: 'expense', categoryKey: 'office', amountCents: 1_000, description: 'Extension cord' },
    ])
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().movement.id as string
    expect(await entry(`pettycash.spend:${id}`)).toEqual([['1011', 'credit', 1_000], ['6170', 'debit', 1_000]])
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: id, kind: 'capex' } })
    expect(line).toMatchObject({ accountCode: '1340', capexLineId: capex['A'] })
    expect(await entry(`capex.payment:${line.capexPaymentId}`)).toEqual([['1011', 'credit', 5_000], ['1340', 'debit', 5_000]])
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id: line.capexPaymentId! } })).toMatchObject({ source: 'cash', paidAmountCents: 5_000 })
    expect(await floatOf(box['A']!)).toBe(float - 6_000)
  })

  it('an all-equipment spend is booked by its CapEx payment alone; B\'s CapEx line → 422; the tie-out holds', async () => {
    const r = await spend('finA', box['A']!, 2_000, [{ kind: 'capex', capexLineId: capex['A'], amountCents: 2_000, description: 'Blender jar' }])
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().movement.id as string
    expect(await entry(`pettycash.spend:${id}`)).toBeNull()
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: id } })
    const capexEntry = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: T.A, reference: `capex.payment:${line.capexPaymentId}` } })
    expect((await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id } })).journalEntryId).toBe(capexEntry.id)
    const foreign = await spend('finA', box['A']!, 1_000, [{ kind: 'capex', capexLineId: capex['B'], amountCents: 1_000, description: 'x' }])
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('CAPEX_LINE_NOT_IN_COMPANY')
    const tie = (await pettyCashTieOut([T.A]))[0]!
    expect(tie, JSON.stringify(tie)).toMatchObject({ ok: true, unbookedMovements: 0, boxesWithoutOpening: 0 })
  })
})
