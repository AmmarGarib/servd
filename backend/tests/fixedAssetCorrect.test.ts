// Edit an asset's details and correct its cost / in-service date / class (owner, 2026-11-27: "How can edit asset
// details, amounts etc?" → "Build both"). Two companies (A, B).
//   • PATCH /:id — name, serial, notes, warranty: at once, audited; company B 404; a cost in the body is refused.
//   • POST /:id/requests {kind:'correct'} — finance 202 (nothing changes), the CEO approves: the acquisition entry is
//     re-posted at the correct cost / date against the SAME offset account, depreciation is charged again from the
//     in-service month; the CEO's own applies at once; company B 404; "nothing changes" 422.
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
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { addMonths, currentPeriodPkt } from '../src/modules/fixedAssets/schedule.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const BASE = '/accounting/fixed-assets'
const day = (k: number) => `${addMonths(currentPeriodPkt(), k)}-15`
let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
let A: string, B: string, kitchenA: string, costCode: string, locA: string, assetId: string

async function mkUser(key: string, role: UserRole, tenantId: string) {
  const u = await prisma.user.create({ data: { name: key, email: `${key}.${RUN}@facorrect.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId } })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[key]!.token}` }, ...(payload !== undefined && { payload: payload as object }) })
async function balance(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { account: { code, tenantId }, journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
async function trial(tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
const charged = async () => (await prisma.fixedAssetDepreciation.findMany({ where: { assetId, reversedAt: null } })).reduce((t, r) => t + Number(r.amountCents), 0)

beforeAll(async () => {
  for (const n of ['A', 'B']) {
    const id = (await prisma.tenant.create({ data: { name: `Correct ${n} ${RUN}`, slug: `fac-${n.toLowerCase()}-${RUN}` } })).id
    await ensureChartOfAccounts(id); await ensureAssetClasses(id)
    if (n === 'A') A = id; else B = id
  }
  const cls = await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: A, key: 'kitchen_equipment' } })
  kitchenA = cls.id; costCode = cls.costAccountCode
  locA = (await prisma.location.create({ data: { name: 'Correct outlet', slug: `fac-l-${RUN}`, tenantId: A } })).id
  await mkUser('ceoA', 'admin', A); await mkUser('finA', 'finance', A); await mkUser('finB', 'finance', B)
  invalidateSetupCache()
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(fixedAssetRoutes, { prefix: BASE })
  await app.ready()
  // The CEO adds a container bought before servd: PKR 2,400 over 24 months, in service two months ago.
  const r = await call('ceoA', 'POST', `${BASE}/existing`, { source: 'pre_servd', classId: kitchenA, name: 'Container', locationId: locA, valueCents: 240_000, inServiceDate: day(-2), remainingLifeMonths: 24, reason: 'Container bought before servd went live' })
  expect(r.statusCode, r.body).toBe(201)
  assetId = (await prisma.fixedAsset.findFirstOrThrow({ where: { tenantId: A } })).id
}, 120_000)
afterAll(async () => { invalidateSetupCache(); await app?.close() })

describe('edit an asset and correct its cost / date', () => {
  it('details are edited at once; another company gets 404; a cost in the body is refused', async () => {
    const ok = await call('finA', 'PATCH', `${BASE}/${assetId}`, { name: 'Container 20ft', serialNumber: 'CN-77', warrantyUntil: '2027-12-31', notes: 'Padel site' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await prisma.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({ name: 'Container 20ft', serialNumber: 'CN-77', notes: 'Padel site' })
    expect((await call('finB', 'PATCH', `${BASE}/${assetId}`, { name: 'Hacked' })).statusCode).toBe(404)
    expect((await call('finA', 'PATCH', `${BASE}/${assetId}`, { costCents: 1 })).json().error.code).toBe('FIELD_NOT_EDITABLE')
  })

  it('finance asks, nothing changes; the CEO approves: re-posted at the correct cost, depreciation charged again', async () => {
    expect((await call('finB', 'POST', `${BASE}/${assetId}/requests`, { kind: 'correct', reason: 'Wrong amount typed', payload: { costCents: 480_000 } })).statusCode).toBe(404)
    const r = await call('finA', 'POST', `${BASE}/${assetId}/requests`, { kind: 'correct', reason: 'Wrong amount typed at entry', payload: { costCents: 480_000 } })
    expect(r.statusCode, r.body).toBe(202)
    expect(Number((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })).costCents)).toBe(240_000)
    expect(await balance(A, costCode)).toBe(240_000)
    const again = await call('finA', 'POST', `${BASE}/${assetId}/requests`, { kind: 'correct', reason: 'Wrong amount typed at entry', payload: { costCents: 500_000 } })
    expect(again.json().error.code).toBe('REQUEST_PENDING')
    expect((await call('finA', 'POST', `${BASE}/requests/${r.json().event.id}/approve`, {})).statusCode).toBe(403)
    const ap = await call('ceoA', 'POST', `${BASE}/requests/${r.json().event.id}/approve`, {})
    expect(ap.statusCode, ap.body).toBe(200)
    const a = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })
    expect([Number(a.costCents), Number(a.originalCostCents), a.status]).toEqual([480_000, 480_000, 'active'])
    expect(await balance(A, costCode)).toBe(480_000)
    expect(await balance(A, '3010')).toBe(-480_000)
    expect(await trial(A)).toBe(0)
    // Two completed months at 480,000 / 24.
    expect(await charged()).toBe(40_000)
  })

  it('the CEO corrects the date at once; "nothing changes" is refused', async () => {
    const r = await call('ceoA', 'POST', `${BASE}/${assetId}/requests`, { kind: 'correct', reason: 'It went into service a month later', payload: { inServiceAt: day(-1) } })
    expect(r.statusCode, r.body).toBe(201)
    const a = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })
    expect(a.inServiceAt!.toISOString().slice(0, 7)).toBe(day(-1).slice(0, 7))
    expect(await charged()).toBe(20_000)
    expect(await balance(A, costCode)).toBe(480_000)
    expect(await trial(A)).toBe(0)
    const same = await call('ceoA', 'POST', `${BASE}/${assetId}/requests`, { kind: 'correct', reason: 'Nothing really changes here', payload: { costCents: 480_000 } })
    expect(same.json().error.code).toBe('NOTHING_TO_CORRECT')
  })
})
