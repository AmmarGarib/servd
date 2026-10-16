// "Received, not billed" routes (/procurement/grni, procurement/grniRoutes.ts).
//
//   - GET / lists a company's open receipt lines (received − billed, value,
//     age) and its billed-ahead matches; company B never sees A's.
//   - GET /unbilled-lines?supplierId — the bill form's picker; another
//     company's supplier is 404.
//   - Write-off: finance asks (a reason), a non-CEO approve is 403, the CEO
//     approves → 'procurement.grni_writeoff:<lineId>' Dr 2015 / Cr 5060; a
//     request the CEO raises applies at once; 409 NOTHING_OPEN /
//     WRITE_OFF_PENDING / NO_WRITE_OFF_REQUEST; company B gets 404 on A's line.
//     Audit rows are filed under the receipt's company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createBill } from '../src/modules/procurement/service.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { grniRoutes } from '../src/modules/procurement/grniRoutes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const PHOTO = 'https://example.com/dock.jpg'
let tenantA: string, tenantB: string, supA: string, supB: string
let lineAsked: string, lineCeo: string, lineBilled: string, lineB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@grniroutes.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })
async function dock(who: string, supplierId: string, tenantId: string, name: string, qty: number, cost: number) {
  const item = (await prisma.inventoryItem.create({ data: { name: `${name} ${RUN}`, unit: 'kg', tenantId, currentStock: 0 } })).id
  const r = await receiveGoods({ actor: { id: users[who]!.id, role: 'admin' }, supplierId, photoUrl: PHOTO, lines: [{ inventoryItemId: item, quantityReceived: qty, unitCostCents: cost }] })
  return { item, line: r.receipt.lines[0]!.id }
}
async function net(tenantId: string, code: string, reference: string) {
  const lines = await prisma.journalLine.findMany({ where: { account: { code, tenantId }, journalEntry: { tenantId, reference } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GR A', slug: `gr-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'GR B', slug: `gr-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('finB', 'finance', tenantB)
  supA = (await prisma.supplier.create({ data: { name: `GR Veg ${RUN}`, tenantId: tenantA } })).id
  supB = (await prisma.supplier.create({ data: { name: `GR B Veg ${RUN}`, tenantId: tenantB } })).id
  lineAsked = (await dock('ceoA', supA, tenantA, 'Tomato', 10, 200)).line
  lineCeo = (await dock('ceoA', supA, tenantA, 'Onion', 5, 100)).line
  const billed = await dock('ceoA', supA, tenantA, 'Garlic', 2, 500)
  lineBilled = billed.line
  await createBill({
    supplierId: supA, billNumber: `GR-B1-${RUN}`, billDate: new Date().toISOString(), createdBy: users['ceoA']!.id,
    lines: [{ inventoryItemId: billed.item, receiptLineId: billed.line, description: 'garlic', quantity: 2, unitCostCents: 500 }],
  })
  lineB = (await dock('ceoB', supB, tenantB, 'B Potato', 3, 100)).line

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(grniRoutes, { prefix: '/procurement/grni' })
  await app.ready()
})

afterAll(async () => { invalidateSetupCache(); await app.close() })

describe('the list and the picker', () => {
  it('GET / lists A\'s open lines (not billed ones), with value and age; B sees only its own', async () => {
    const res = await call('finA', 'GET', '/procurement/grni')
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    const ids = (body.lines as Array<{ receiptLineId: string }>).map((l) => l.receiptLineId)
    expect(ids.sort()).toEqual([lineAsked, lineCeo].sort())
    expect(body.lines.find((l: { receiptLineId: string }) => l.receiptLineId === lineAsked)).toMatchObject({
      tenantId: tenantA, supplierId: supA, openQty: 10, unitCostCents: 200, openValueCents: 2_000, ageDays: 0, stale: false, writeOffRequest: null,
    })
    expect(body.totals.openValueCents).toBe(2_500)
    // What the page may offer: finance asks, only the CEO approves.
    expect(body).toMatchObject({ canApprove: false, canRequestWriteOff: true })
    expect((await call('ceoA', 'GET', '/procurement/grni')).json()).toMatchObject({ canApprove: true, canRequestWriteOff: true })
    const b = (await call('finB', 'GET', '/procurement/grni')).json()
    expect((b.lines as Array<{ receiptLineId: string }>).map((l) => l.receiptLineId)).toEqual([lineB])
    expect((await call('finB', 'GET', `/procurement/grni?tenantId=${tenantA}`)).statusCode).toBe(404)
  })

  it('GET /unbilled-lines: the supplier\'s open lines; another company\'s supplier is 404', async () => {
    const res = await call('mgrA', 'GET', `/procurement/grni/unbilled-lines?supplierId=${supA}`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as Array<{ receiptLineId: string; openQty: number }>).map((l) => l.receiptLineId).sort()).toEqual([lineAsked, lineCeo].sort())
    expect((await call('finB', 'GET', `/procurement/grni/unbilled-lines?supplierId=${supA}`)).statusCode).toBe(404)
  })
})

describe('writing a line off — finance asks, the CEO approves', () => {
  it('company B gets 404 on A\'s line; a fully billed line is 409 NOTHING_OPEN', async () => {
    expect((await call('finB', 'POST', `/procurement/grni/${lineAsked}/write-off-request`, { reason: 'supplier closed' })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/procurement/grni/${lineAsked}/write-off/approve`, {})).statusCode).toBe(404)
    const billed = await call('finA', 'POST', `/procurement/grni/${lineBilled}/write-off-request`, { reason: 'supplier closed' })
    expect(billed.statusCode).toBe(409)
    expect(billed.json().error.code).toBe('NOTHING_OPEN')
  })

  it('finance asks (with a reason); asking twice is 409; a manager cannot approve (403); the CEO approves → Dr 2015 / Cr 5060', async () => {
    expect((await call('finA', 'POST', `/procurement/grni/${lineAsked}/write-off-request`, { reason: 'x' })).statusCode).toBe(400)
    const ask = await call('finA', 'POST', `/procurement/grni/${lineAsked}/write-off-request`, { reason: 'Supplier went out of business' })
    expect(ask.statusCode, ask.body).toBe(200)
    expect(ask.json().status).toBe('requested')
    const again = await call('finA', 'POST', `/procurement/grni/${lineAsked}/write-off-request`, { reason: 'Supplier went out of business' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('WRITE_OFF_PENDING')
    // The approvals inbox reads the requested ones.
    const pending = (await call('ceoA', 'GET', '/procurement/grni?writeOffRequested=1')).json()
    expect((pending.lines as Array<{ receiptLineId: string; writeOffRequest: { reason: string } }>).map((l) => [l.receiptLineId, l.writeOffRequest.reason])).toEqual([[lineAsked, 'Supplier went out of business']])

    expect((await call('mgrA', 'POST', `/procurement/grni/${lineAsked}/write-off/approve`, {})).statusCode).toBe(403)
    expect((await call('finA', 'POST', `/procurement/grni/${lineAsked}/write-off/approve`, {})).statusCode).toBe(403)
    const ok = await call('ceoA', 'POST', `/procurement/grni/${lineAsked}/write-off/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'written_off', valueCents: 2_000 })
    const ref = `procurement.grni_writeoff:${lineAsked}`
    expect(await net(tenantA, '2015', ref)).toBe(2_000)
    expect(await net(tenantA, '5060', ref)).toBe(-2_000)
    expect(await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: lineAsked } })).toMatchObject({ writtenOffById: users['ceoA']!.id, writeOffEntryId: ok.json().entryId })
    // Gone from the list; a second approve finds nothing open.
    const list = (await call('finA', 'GET', '/procurement/grni')).json()
    expect((list.lines as Array<{ receiptLineId: string }>).map((l) => l.receiptLineId)).toEqual([lineCeo])
    expect((await call('ceoA', 'POST', `/procurement/grni/${lineAsked}/write-off/approve`, {})).json().error.code).toBe('NOTHING_OPEN')
    const audits = await prisma.auditLog.findMany({ where: { entity: 'GoodsReceiptLine', entityId: lineAsked, action: { not: 'approval.decide' } }, select: { action: true, tenantId: true } })
    expect(audits.map((a) => a.action).sort()).toEqual(['procurement.grni_writeoff.approve', 'procurement.grni_writeoff.request'])
    expect(audits.every((a) => a.tenantId === tenantA)).toBe(true)
  })

  it('a request the CEO raises applies at once', async () => {
    const res = await call('ceoA', 'POST', `/procurement/grni/${lineCeo}/write-off-request`, { reason: 'Free samples, never billed' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ status: 'written_off', valueCents: 500 })
    expect(await net(tenantA, '2015', `procurement.grni_writeoff:${lineCeo}`)).toBe(500)
  })

  it('reject: the CEO clears a request with a note; with none pending it is 409 NO_WRITE_OFF_REQUEST', async () => {
    expect((await call('ceoB', 'POST', `/procurement/grni/${lineB}/write-off/reject`, { note: 'no request yet' })).json().error.code).toBe('NO_WRITE_OFF_REQUEST')
    expect((await call('finB', 'POST', `/procurement/grni/${lineB}/write-off-request`, { reason: 'Supplier says it was a gift' })).statusCode).toBe(200)
    expect((await call('finB', 'POST', `/procurement/grni/${lineB}/write-off/reject`, { note: 'no' })).statusCode).toBe(403)
    const rej = await call('ceoB', 'POST', `/procurement/grni/${lineB}/write-off/reject`, { note: 'They will bill it — chase them' })
    expect(rej.statusCode).toBe(200)
    expect(await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: lineB } })).toMatchObject({ writeOffRequestedAt: null, writtenOffAt: null })
    expect(await prisma.auditLog.count({ where: { entityId: lineB, action: 'procurement.grni_writeoff.reject', tenantId: tenantB } })).toBe(1)
  })
})
