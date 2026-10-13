// Cash vouchers (owner, 2026-10-13): draft → HOD → director → the photo of the
// cashier-signed paper turns it into ONE petty-cash spend.
//
//   - Two companies, A and B: a voucher binds to the active company; B gets
//     404 on every one of A's vouchers (read, edit, sign, approve, pay, photo);
//     A cannot pay from B's box; numbers are per company.
//   - Preparing, signing and approving never touch cash; only the disburse
//     (photo upload) does — exactly one spend, exactly once, rolled back whole
//     when the box cannot cover it.
//   - The director is the CEO (admin) and never the login that signed as HOD.
//   - The manual petty-cash spend goes through the same helper.
//   - The approvals inbox lists the voucher waiting for the director, per company.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { registerApprovalsPlugin } from '../src/modules/approvals/index.js'
import { CASH_VOUCHER_PHOTO_MAX_BYTES } from '../src/modules/trustops/cashVouchers.js'

const P = `cv${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const C: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}

// A real 1×1 JPEG (134 bytes).
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
const JPEG = Buffer.from(JPEG_B64, 'base64')
const PHOTO = { photo: JPEG_B64, mime: 'image/jpeg' }

async function mkUser(key: string, role: UserRole, tenants: string[], primary: string | null = tenants[0] ?? null) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cv.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: primary, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
function auth(key: string, extra: Record<string, string> = {}) {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession(u).accessToken}`, ...extra }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/v1${url}`, headers: auth(key, extra), ...(payload !== undefined && { payload: payload as object }) })

const V = '/trustops/cash-vouchers'
type Voucher = {
  id: string; tenantId: string; number: string; seq: number; status: string; amountCents: number; boxId: string
  preparedById: string; hodSignedById: string | null; directorSignedById: string | null; disbursedById: string | null
  pettyCashMovementId: string | null; cashierName: string | null; hasPhoto: boolean; boxName: string
  custodianName: string | null; preparedByName: string | null; hodSignedByName: string | null; directorSignedByName: string | null
  companyName: string | null; rejectNote: string | null; cancelNote: string | null
}

let n = 0
const draft = (overrides: Record<string, unknown> = {}) => ({
  payeeName: 'Ammar Garib', purpose: `Site visit cash ${++n}`, category: 'transport', amountCents: 10_000, boxId: box['A'], ...overrides,
})
async function create(key: string, overrides: Record<string, unknown> = {}): Promise<Voucher> {
  const r = await call(key, 'POST', V, draft(overrides))
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as Voucher
}
/** A voucher at `approved`: prepared + HOD-signed by `hod`, signed by `director`. */
async function approved(overrides: Record<string, unknown> = {}, hod = 'finA', director = 'ceoA'): Promise<Voucher> {
  const v = await create(hod, overrides)
  expect((await call(hod, 'POST', `${V}/${v.id}/sign-hod`)).statusCode).toBe(200)
  const r = await call(director, 'POST', `${V}/${v.id}/approve`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Voucher
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents
const movementsOf = (id: string) => prisma.pettyCashMovement.count({ where: { boxId: id } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Voucher Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Voucher Co B', slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} brand A`, slug: `${P}-brand-a`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} brand B`, slug: `${P}-brand-b`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoA2', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('mgrA', 'management', [T.A])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('cashA2', 'cashier', [T.A])
  await mkUser('cashB', 'cashier', [T.B])
  await mkUser('finNoCompany', 'finance', [], null)
  await mkUser('finNoBooks', 'finance', [T.A])
  await prisma.user.update({ where: { id: U['finNoBooks']!.id }, data: { moduleDeny: ['accounting'] } })

  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Head office box', custodianId: U['cashA']!.id, floatCents: 100_000 } })).id
  box['A_small'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Small box', custodianId: U['cashA']!.id, floatCents: 1_000 } })).id
  box['A_closed'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Closed box', custodianId: U['cashA']!.id, floatCents: 100_000, isActive: false } })).id
  box['B'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['cashB']!.id, floatCents: 50_000 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

// ─── Create ───────────────────────────────────────────────────────────────────

describe('a voucher binds to the active company', () => {
  it('create: draft, stamped with the active company, numbered per company, no cash moves', async () => {
    const before = await floatOf(box['A']!)
    const a1 = await create('finA', { conceptId: C.A, department: 'Head office', payeeUserId: U['ceoA']!.id })
    expect(a1).toMatchObject({
      tenantId: T.A, status: 'draft', preparedById: U['finA']!.id, boxName: 'Head office box',
      custodianName: `${P} cashA`, preparedByName: `${P} finA`, companyName: 'Voucher Co A', hasPhoto: false, pettyCashMovementId: null,
    })
    expect(a1.number).toBe('CV-00001')
    const a2 = await create('finA')
    expect(a2.number).toBe('CV-00002')
    const b1 = await create('finB', { boxId: box['B'] })
    expect(b1).toMatchObject({ tenantId: T.B, number: 'CV-00001', seq: 1 })
    // Generating a voucher never puts it in the cash section.
    expect(await floatOf(box['A']!)).toBe(before)
    expect(await movementsOf(box['A']!)).toBe(0)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'cash_voucher.create', entityId: a1.id } })
    expect(audit?.tenantId).toBe(T.A)
  })

  it("another company's box, brand or payee is refused; a closed box too", async () => {
    const foreignBox = await call('finA', 'POST', V, draft({ boxId: box['B'] }))
    expect(foreignBox.statusCode).toBe(422)
    expect(foreignBox.json().error.code).toBe('BOX_NOT_IN_COMPANY')
    const closed = await call('finA', 'POST', V, draft({ boxId: box['A_closed'] }))
    expect(closed.statusCode).toBe(422)
    expect(closed.json().error.code).toBe('BOX_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', V, draft({ conceptId: C.B }))).statusCode).toBe(404)
    const payee = await call('finA', 'POST', V, draft({ payeeUserId: U['cashB']!.id }))
    expect(payee.statusCode).toBe(422)
    expect(payee.json().error.code).toBe('PAYEE_NOT_IN_COMPANY')
    expect(await prisma.cashVoucher.count({ where: { tenantId: T.B, boxId: box['B'], preparedById: U['finA']!.id } })).toBe(0)
  })

  it('amount must be positive and fit INT4; no active company → 422; cashier and finance without the module → 403', async () => {
    expect((await call('finA', 'POST', V, draft({ amountCents: 0 }))).statusCode).toBe(400)
    const big = await call('finA', 'POST', V, draft({ amountCents: 2_147_483_648 }))
    expect(big.statusCode).toBe(422)
    expect(big.json().error.code).toBe('AMOUNT_TOO_LARGE')
    const none = await call('finNoCompany', 'POST', V, draft())
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('NO_ACTIVE_COMPANY')
    expect((await call('cashA', 'POST', V, draft())).statusCode).toBe(403)
    expect((await call('finNoBooks', 'POST', V, draft())).statusCode).toBe(403)
    // Not a cash keeper and holds no box: the list opens but is empty.
    const noBooks = await call('finNoBooks', 'GET', V)
    expect(noBooks.statusCode).toBe(200)
    expect((noBooks.json() as { items: Voucher[] }).items).toHaveLength(0)
  })
})

// ─── Company B ────────────────────────────────────────────────────────────────

describe("company B never reaches company A's voucher", () => {
  it('404 on read, edit, sign, approve, reject, cancel, pay and photo; the list is per company', async () => {
    const a = await approved()
    // Give A's voucher a photo-less approved state and check every door from B.
    expect((await call('finB', 'GET', `${V}/${a.id}`)).statusCode).toBe(404)
    expect((await call('cashB', 'GET', `${V}/${a.id}`)).statusCode).toBe(404)
    expect((await call('finB', 'PATCH', `${V}/${a.id}`, { amountCents: 1 })).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${V}/${a.id}/sign-hod`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `${V}/${a.id}/approve`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `${V}/${a.id}/reject`, { note: 'not ours' })).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${V}/${a.id}/cancel`, { note: 'not ours' })).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${V}/${a.id}/disburse`, PHOTO)).statusCode).toBe(404)
    expect((await call('cashB', 'POST', `${V}/${a.id}/disburse`, PHOTO)).statusCode).toBe(404)
    expect((await call('finB', 'GET', `${V}/${a.id}/photo`)).statusCode).toBe(404)
    const still = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: a.id } })
    expect(still.status).toBe('approved')
    expect(await prisma.cashVoucherAttachment.count({ where: { voucherId: a.id } })).toBe(0)

    const listB = (await call('finB', 'GET', V)).json() as { items: Voucher[] }
    expect(listB.items.every((v) => v.tenantId === T.B)).toBe(true)
    expect(listB.items.map((v) => v.id)).not.toContain(a.id)
    const listA = (await call('finA', 'GET', V)).json() as { items: Voucher[] }
    expect(listA.items.map((v) => v.id)).toContain(a.id)
    expect(listA.items.every((v) => v.tenantId === T.A)).toBe(true)
  })

  it('the list filters by status and pages with a cursor; a foreign cursor is refused', async () => {
    const page1 = (await call('finA', 'GET', `${V}?limit=2`)).json() as { items: Voucher[]; nextCursor: string | null }
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBe(page1.items[1]!.id)
    const page2 = (await call('finA', 'GET', `${V}?limit=2&cursor=${page1.nextCursor}`)).json() as { items: Voucher[] }
    expect(page2.items.length).toBeGreaterThan(0)
    for (const v of page2.items) expect(page1.items.map((x) => x.id)).not.toContain(v.id)
    const drafts = (await call('finA', 'GET', `${V}?status=draft`)).json() as { items: Voucher[] }
    expect(drafts.items.length).toBeGreaterThan(0)
    expect(drafts.items.every((v) => v.status === 'draft')).toBe(true)
    // The list never carries the photo bytes.
    expect(JSON.stringify(drafts)).not.toContain('"data"')
    const bVoucher = await prisma.cashVoucher.findFirstOrThrow({ where: { tenantId: T.B } })
    expect((await call('finA', 'GET', `${V}?cursor=${bVoucher.id}`)).statusCode).toBe(400)
    expect((await call('finA', 'GET', `${V}?status=nope`)).statusCode).toBe(400)
  })
})

describe('the cashier who holds the box finds the vouchers to pay', () => {
  it('lists only approved / paid vouchers on boxes they hold — never drafts, never another box or company', async () => {
    const draftV = await create('finA')
    const ready = await approved()
    const list = (await call('cashA', 'GET', V)).json() as { items: Voucher[] }
    const ids = list.items.map((v) => v.id)
    expect(ids).toContain(ready.id)
    expect(ids).not.toContain(draftV.id)
    expect(list.items.every((v) => v.tenantId === T.A && ['approved', 'disbursed'].includes(v.status))).toBe(true)
    // Asking for drafts by status still shows none (nothing to pay yet).
    const drafts = (await call('cashA', 'GET', `${V}?status=draft`)).json() as { items: Voucher[] }
    expect(drafts.items).toHaveLength(0)
    // A cashier of the same company who holds no box sees nothing; company B's cashier never sees A's.
    expect(((await call('cashA2', 'GET', V)).json() as { items: Voucher[] }).items).toHaveLength(0)
    const b = (await call('cashB', 'GET', V)).json() as { items: Voucher[] }
    expect(b.items.map((v) => v.id)).not.toContain(ready.id)
    expect(b.items.every((v) => v.tenantId === T.B)).toBe(true)
  })
})

// ─── The full flow ────────────────────────────────────────────────────────────

describe('draft → HOD → director → the signed photo pays it, once', () => {
  it('only the disburse moves cash: one spend, the float drops once, the voucher links the movement', async () => {
    const boxId = box['A']!
    const start = await floatOf(boxId)
    const startMovements = await movementsOf(boxId)

    const v = await create('finA', { amountCents: 25_000, purpose: 'Diesel for the generator' })
    // The preparer edits the draft.
    const edited = await call('finA', 'PATCH', `${V}/${v.id}`, { amountCents: 30_000, department: 'Ops' })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().amountCents).toBe(30_000)
    // Not approved yet: paying is refused.
    const early = await call('cashA', 'POST', `${V}/${v.id}/disburse`, PHOTO)
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('VOUCHER_NOT_APPROVED')

    // The HOD signs (a manager); a draft can no longer be edited.
    const hod = await call('mgrA', 'POST', `${V}/${v.id}/sign-hod`)
    expect(hod.statusCode).toBe(200)
    expect(hod.json()).toMatchObject({ status: 'hod_signed', hodSignedById: U['mgrA']!.id, hodSignedByName: `${P} mgrA` })
    const late = await call('finA', 'PATCH', `${V}/${v.id}`, { amountCents: 1 })
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('VOUCHER_NOT_DRAFT')

    // Finance cannot sign as director; the CEO does.
    expect((await call('finA', 'POST', `${V}/${v.id}/approve`)).statusCode).toBe(403)
    expect((await call('mgrA', 'POST', `${V}/${v.id}/approve`)).statusCode).toBe(403)
    const dir = await call('ceoA', 'POST', `${V}/${v.id}/approve`)
    expect(dir.statusCode).toBe(200)
    expect(dir.json()).toMatchObject({ status: 'approved', directorSignedById: U['ceoA']!.id })
    // Signed and printable — still nothing in the cash section.
    expect(await floatOf(boxId)).toBe(start)
    expect(await movementsOf(boxId)).toBe(startMovements)

    // A cashier who does not hold the box can neither open nor pay it.
    expect((await call('cashA2', 'GET', `${V}/${v.id}`)).statusCode).toBe(403)
    expect((await call('cashA2', 'POST', `${V}/${v.id}/disburse`, PHOTO)).statusCode).toBe(403)
    // The custodian (the cashier) opens it…
    const seen = await call('cashA', 'GET', `${V}/${v.id}`)
    expect(seen.statusCode).toBe(200)
    expect(seen.json()).toMatchObject({ boxName: 'Head office box', custodianName: `${P} cashA`, hasPhoto: false })

    // …and uploads the photo of the signed paper: the cash leaves the box.
    const paid = await call('cashA', 'POST', `${V}/${v.id}/disburse`, PHOTO)
    expect(paid.statusCode, paid.body).toBe(200)
    const body = paid.json() as { voucher: Voucher; movement: { id: string; amountCents: number }; newFloatCents: number }
    expect(body.voucher).toMatchObject({ status: 'disbursed', disbursedById: U['cashA']!.id, cashierName: `${P} cashA`, hasPhoto: true })
    expect(body.voucher.pettyCashMovementId).toBe(body.movement.id)
    expect(body.movement.amountCents).toBe(-30_000)
    expect(body.newFloatCents).toBe(start - 30_000)
    expect(await floatOf(boxId)).toBe(start - 30_000)
    expect(await movementsOf(boxId)).toBe(startMovements + 1)
    const m = await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: body.movement.id } })
    expect(m).toMatchObject({
      type: 'spend', amountCents: -30_000, category: 'transport', vendorName: 'Ammar Garib',
      approvedById: U['ceoA']!.id, createdById: U['cashA']!.id, reason: `Cash voucher ${v.number}: Diesel for the generator`,
    })

    // A second upload can never pay twice.
    const again = await call('finA', 'POST', `${V}/${v.id}/disburse`, PHOTO)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_DISBURSED')
    expect(await floatOf(boxId)).toBe(start - 30_000)
    expect(await movementsOf(boxId)).toBe(startMovements + 1)
    expect(await prisma.cashVoucherAttachment.count({ where: { voucherId: v.id } })).toBe(1)

    // The photo: the same bytes back, for finance and the custodian; nobody else.
    const img = await call('finA', 'GET', `${V}/${v.id}/photo`)
    expect(img.statusCode).toBe(200)
    expect(img.headers['content-type']).toBe('image/jpeg')
    expect(img.rawPayload.equals(JPEG)).toBe(true)
    expect((await call('cashA', 'GET', `${V}/${v.id}/photo`)).statusCode).toBe(200)
    expect((await call('cashA2', 'GET', `${V}/${v.id}/photo`)).statusCode).toBe(403)
    expect((await call('ceoB', 'GET', `${V}/${v.id}/photo`)).statusCode).toBe(404)

    // Every step is on the audit trail, in company A.
    const steps = await prisma.auditLog.findMany({ where: { entity: 'CashVoucher', entityId: v.id }, select: { action: true, tenantId: true } })
    expect(steps.map((s) => s.action).sort()).toEqual(
      ['cash_voucher.approve', 'cash_voucher.create', 'cash_voucher.disburse', 'cash_voucher.sign_hod', 'cash_voucher.update'],
    )
    expect(steps.every((s) => s.tenantId === T.A)).toBe(true)
  })

  it('two uploads at the same moment pay once', async () => {
    const boxId = box['A']!
    const v = await approved({ amountCents: 4_000 })
    const float = await floatOf(boxId)
    const moves = await movementsOf(boxId)
    const [r1, r2] = await Promise.all([
      call('cashA', 'POST', `${V}/${v.id}/disburse`, PHOTO),
      call('finA', 'POST', `${V}/${v.id}/disburse`, PHOTO),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    expect([r1, r2].find((r) => r.statusCode === 409)!.json().error.code).toBe('ALREADY_DISBURSED')
    expect(await floatOf(boxId)).toBe(float - 4_000)
    expect(await movementsOf(boxId)).toBe(moves + 1)
    expect(await prisma.cashVoucherAttachment.count({ where: { voucherId: v.id } })).toBe(1)
  })

  it('a voucher with no photo yet answers 404 on /photo', async () => {
    const v = await create('finA')
    expect((await call('finA', 'GET', `${V}/${v.id}/photo`)).statusCode).toBe(404)
  })

  it('two different people sign: the HOD cannot also sign as director (409 SAME_SIGNER)', async () => {
    const v = await create('ceoA')
    const notYet = await call('ceoA', 'POST', `${V}/${v.id}/approve`)
    expect(notYet.statusCode).toBe(409)
    expect(notYet.json().error.code).toBe('VOUCHER_NOT_HOD_SIGNED')
    expect((await call('ceoA', 'POST', `${V}/${v.id}/sign-hod`)).statusCode).toBe(200)
    const same = await call('ceoA', 'POST', `${V}/${v.id}/approve`)
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('SAME_SIGNER')
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('hod_signed')
    const other = await call('ceoA2', 'POST', `${V}/${v.id}/approve`)
    expect(other.statusCode).toBe(200)
    expect(other.json()).toMatchObject({ status: 'approved', hodSignedById: U['ceoA']!.id, directorSignedById: U['ceoA2']!.id })
  })

  it('INSUFFICIENT_FLOAT rolls the whole payment back: still approved, no photo, no movement', async () => {
    const boxId = box['A_small']!
    const v = await approved({ boxId, amountCents: 5_000 })
    const r = await call('cashA', 'POST', `${V}/${v.id}/disburse`, PHOTO)
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('INSUFFICIENT_FLOAT')
    const after = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(after).toMatchObject({ status: 'approved', pettyCashMovementId: null, disbursedAt: null, disbursedById: null, cashierName: null })
    expect(await prisma.cashVoucherAttachment.count({ where: { voucherId: v.id } })).toBe(0)
    expect(await movementsOf(boxId)).toBe(0)
    expect(await floatOf(boxId)).toBe(1_000)
  })
})

// ─── Reject / cancel ──────────────────────────────────────────────────────────

describe('reject and cancel', () => {
  it('the director rejects a HOD-signed voucher with a note; finance cannot; it can never be paid', async () => {
    const v = await create('finA')
    expect((await call('finA', 'POST', `${V}/${v.id}/sign-hod`)).statusCode).toBe(200)
    expect((await call('ceoA', 'POST', `${V}/${v.id}/reject`, { note: 'no' })).statusCode).toBe(400)
    expect((await call('finA', 'POST', `${V}/${v.id}/reject`, { note: 'not needed' })).statusCode).toBe(403)
    const r = await call('ceoA', 'POST', `${V}/${v.id}/reject`, { note: 'Use the company card' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ status: 'rejected', rejectNote: 'Use the company card' })
    expect((await call('ceoA', 'POST', `${V}/${v.id}/reject`, { note: 'again please' })).statusCode).toBe(409)
    expect((await call('ceoA', 'POST', `${V}/${v.id}/approve`)).statusCode).toBe(409)
    const pay = await call('cashA', 'POST', `${V}/${v.id}/disburse`, PHOTO)
    expect(pay.statusCode).toBe(409)
    expect(pay.json().error.code).toBe('VOUCHER_NOT_APPROVED')
  })

  it('cancel works before payment (draft, HOD-signed, approved), needs a note, and never after payment', async () => {
    const d = await create('finA')
    expect((await call('finA', 'POST', `${V}/${d.id}/cancel`, { note: 'x' })).statusCode).toBe(400)
    expect((await call('cashA', 'POST', `${V}/${d.id}/cancel`, { note: 'typo' })).statusCode).toBe(403)
    const c1 = await call('finA', 'POST', `${V}/${d.id}/cancel`, { note: 'Raised twice' })
    expect(c1.statusCode).toBe(200)
    expect(c1.json()).toMatchObject({ status: 'cancelled', cancelNote: 'Raised twice' })

    const a = await approved()
    const c2 = await call('mgrA', 'POST', `${V}/${a.id}/cancel`, { note: 'Trip called off' })
    expect(c2.statusCode).toBe(200)
    expect(c2.json().status).toBe('cancelled')
    expect((await call('cashA', 'POST', `${V}/${a.id}/disburse`, PHOTO)).statusCode).toBe(409)

    const p = await approved()
    expect((await call('cashA', 'POST', `${V}/${p.id}/disburse`, PHOTO)).statusCode).toBe(200)
    const c3 = await call('finA', 'POST', `${V}/${p.id}/cancel`, { note: 'Too late now' })
    expect(c3.statusCode).toBe(409)
    expect(c3.json().error.code).toBe('VOUCHER_NOT_CANCELLABLE')
  })
})

// ─── The photo ────────────────────────────────────────────────────────────────

describe('the signed-voucher photo is checked', () => {
  it('bad type, mismatched bytes, junk, bad base64 and oversize are 400 BAD_PHOTO and pay nothing', async () => {
    const v = await approved()
    const boxId = box['A']!
    const float = await floatOf(boxId)
    const moves = await movementsOf(boxId)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(CASH_VOUCHER_PHOTO_MAX_BYTES)])
    const cases: Array<[string, { photo: string; mime: string }]> = [
      ['gif', { photo: JPEG_B64, mime: 'image/gif' }],
      ['pdf', { photo: JPEG_B64, mime: 'application/pdf' }],
      ['png said, jpeg sent', { photo: JPEG_B64, mime: 'image/png' }],
      ['jpeg said, png sent', { photo: png.toString('base64'), mime: 'image/jpeg' }],
      ['junk', { photo: Buffer.alloc(200, 7).toString('base64'), mime: 'image/jpeg' }],
      ['not base64', { photo: '%%%not-base64%%%', mime: 'image/jpeg' }],
      ['data url disagrees', { photo: `data:image/png;base64,${JPEG_B64}`, mime: 'image/jpeg' }],
      ['too large', { photo: huge.toString('base64'), mime: 'image/jpeg' }],
    ]
    for (const [label, payload] of cases) {
      const r = await call('cashA', 'POST', `${V}/${v.id}/disburse`, payload)
      expect(r.statusCode, label).toBe(400)
      expect(r.json().error.code, label).toBe('BAD_PHOTO')
    }
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('approved')
    expect(await prisma.cashVoucherAttachment.count({ where: { voucherId: v.id } })).toBe(0)
    expect(await floatOf(boxId)).toBe(float)
    expect(await movementsOf(boxId)).toBe(moves)

    // A data URL of the right type is accepted.
    const ok = await call('cashA', 'POST', `${V}/${v.id}/disburse`, { photo: `data:image/jpeg;base64,${JPEG_B64}`, mime: 'image/jpeg' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await floatOf(boxId)).toBe(float - v.amountCents)
  })
})

// ─── Petty cash keeps one spend path ──────────────────────────────────────────

describe('the manual petty-cash spend goes through the same helper', () => {
  it('spend lowers the float; over the float is 400 INSUFFICIENT_FLOAT; a top-up still works', async () => {
    const boxId = box['A']!
    const float = await floatOf(boxId)
    const r = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId, type: 'spend', amountCents: 2_000, reason: 'Milk', vendorName: 'Dairy shop', category: 'cleaning' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().newFloatCents).toBe(float - 2_000)
    expect(r.json().movement).toMatchObject({ type: 'spend', amountCents: -2_000, vendorName: 'Dairy shop', createdById: U['finA']!.id })
    expect(await floatOf(boxId)).toBe(float - 2_000)

    const over = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box['A_small'], type: 'spend', amountCents: 5_000, reason: 'Too much' })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.code).toBe('INSUFFICIENT_FLOAT')
    expect(await floatOf(box['A_small']!)).toBe(1_000)

    const up = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId, type: 'topup', amountCents: 2_000, reason: 'Refill' })
    expect(up.statusCode).toBe(201)
    expect(up.json().newFloatCents).toBe(float)
  })
})

// ─── Approvals inbox ──────────────────────────────────────────────────────────

type Inbox = {
  types: Array<{ type: string; count: number; link: string; module: string }>
  items: Array<{ type: string; id: string; tenantId: string | null; actions: Array<{ kind: string; method: string; path: string; body: Record<string, unknown>; input?: { field: string; required: boolean }; disabledReason?: string }> }>
}

describe('approvals inbox: the voucher waiting for the director', () => {
  it("lists company A's HOD-signed voucher for A's CEO only; Approve calls the voucher route", async () => {
    const a = await create('finA', { purpose: 'Inbox item A' })
    expect((await call('finA', 'POST', `${V}/${a.id}/sign-hod`)).statusCode).toBe(200)
    const b = await create('finB', { purpose: 'Inbox item B', boxId: box['B'] })
    expect((await call('finB', 'POST', `${V}/${b.id}/sign-hod`)).statusCode).toBe(200)

    const inboxA = (await call('ceoA', 'GET', '/approvals')).json() as Inbox
    const typeA = inboxA.types.find((t) => t.type === 'cash_voucher')
    expect(typeA).toMatchObject({ module: 'accounting' })
    const itemsA = inboxA.items.filter((i) => i.type === 'cash_voucher')
    expect(typeA!.count).toBe(itemsA.length)
    expect(itemsA.map((i) => i.id)).toContain(a.id)
    expect(itemsA.map((i) => i.id)).not.toContain(b.id)
    expect(itemsA.every((i) => i.tenantId === T.A)).toBe(true)

    const inboxB = (await call('ceoB', 'GET', '/approvals')).json() as Inbox
    const idsB = inboxB.items.filter((i) => i.type === 'cash_voucher').map((i) => i.id)
    expect(idsB).toContain(b.id)
    expect(idsB).not.toContain(a.id)

    // Not a director: no cash-voucher type at all.
    const fin = (await call('finA', 'GET', '/approvals/counts')).json() as Inbox
    expect(fin.types.map((t) => t.type)).not.toContain('cash_voucher')

    // The buttons call the module's own routes, whose guards decide.
    const item = itemsA.find((i) => i.id === a.id)!
    const approve = item.actions.find((x) => x.kind === 'approve')!
    expect(approve).toMatchObject({ method: 'POST', path: `${V}/${a.id}/approve` })
    expect(approve.disabledReason).toBeUndefined()
    const reject = item.actions.find((x) => x.kind === 'reject')!
    expect(reject).toMatchObject({ method: 'POST', path: `${V}/${a.id}/reject` })
    expect(reject.input).toMatchObject({ field: 'note', required: true })
    expect((await call('ceoB', 'POST', approve.path, approve.body)).statusCode).toBe(404)
    expect((await call('ceoA', 'POST', approve.path, approve.body)).statusCode).toBe(200)
    const after = (await call('ceoA', 'GET', '/approvals')).json() as Inbox
    expect(after.items.map((i) => i.id)).not.toContain(a.id)
  })

  it('a CEO who signed as HOD sees the voucher with Approve disabled', async () => {
    const v = await create('ceoA', { purpose: 'Signed by the CEO as HOD' })
    expect((await call('ceoA', 'POST', `${V}/${v.id}/sign-hod`)).statusCode).toBe(200)
    const inbox = (await call('ceoA', 'GET', '/approvals')).json() as Inbox
    const item = inbox.items.find((i) => i.id === v.id)!
    expect(item.actions.find((x) => x.kind === 'approve')!.disabledReason).toMatch(/HOD/)
    expect(item.actions.find((x) => x.kind === 'reject')!.disabledReason).toBeUndefined()
    const other = (await call('ceoA2', 'GET', '/approvals')).json() as Inbox
    expect(other.items.find((i) => i.id === v.id)!.actions.find((x) => x.kind === 'approve')!.disabledReason).toBeUndefined()
  })
})
