// Record files (owner, 2026-10-16): supporting documents are FILES in one
// private store (cash_voucher_attachments, kind 'record_file', ownerType +
// ownerId), never URLs. lib/recordFiles.ts + modules/recordFiles.
//
//   • every owner type: company B gets 404 on company A's record (list, file,
//     upload); files are stamped with the RECORD's company; lists carry
//     metadata only; the bytes come back with their type;
//   • a bad file (fake magic / wrong type) → 400, nothing written; > 10 files
//     on a record → 409 TOO_MANY_FILES; an unknown owner type → 404;
//   • each owner keeps its module's own rule: role arrays (403), Module Access
//     (403), HR documents HR_ADMIN + staff_hr only, a prep's photos only by
//     its cook or a manager;
//   • the dock receive takes the photos inline and they satisfy the photo
//     threshold (a bad photo writes no receipt);
//   • the CEO's Trash purge of an HR document erases its files.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { recordFileRoutes } from '../src/modules/recordFiles/routes.js'
import { RECORD_OWNER } from '../src/modules/recordFiles/providers.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { recordFileOwnerTypes, purgeRecordFilesTx, RECORD_FILE_KIND } from '../src/lib/recordFiles.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64')
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]).toString('base64')
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml....'), Buffer.alloc(32, 0)]).toString('base64')
const png = (n = 1) => ({ fileName: `photo-${n}.png`, mime: 'image/png', dataBase64: PNG })
const pdf = { fileName: 'receipt.pdf', mime: 'application/pdf', dataBase64: PDF }
const docx = { fileName: 'contract.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64: DOCX }
const fakePng = { fileName: 'x.png', mime: 'image/png', dataBase64: Buffer.from('not really a png at all, just text padding padding').toString('base64') }

interface Co {
  tenantId: string
  ids: Record<string, string>   // owner type → a record of this company
}
let A: Co, B: Co

async function mkUser(key: string, role: string, tenantId: string, extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@recfiles.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, ...(extra.moduleDeny ? { moduleDeny: extra.moduleDeny } : {}),
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}

async function mkRecords(tag: string, tenantId: string, cook: string): Promise<Co> {
  const cat = await prisma.opexCategory.create({ data: { name: `Rent ${tag}`, tenantId } })
  const line = await prisma.opexLine.create({ data: { categoryId: cat.id, name: 'Office rent', amountCents: 100_000 } })
  const pay = await prisma.opexPayment.create({ data: { lineId: line.id, periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), expectedCents: 100_000 } })
  const sup = await prisma.supplier.create({ data: { name: `Supplier ${tag}`, tenantId } })
  const bill = await prisma.supplierBill.create({ data: { supplierId: sup.id, billNumber: `B-${tag}-${RUN}`, billDate: new Date(), dueDate: new Date() } })
  const grn = await prisma.goodsReceipt.create({ data: { supplierId: sup.id, receivedById: cook, tenantId } })
  const prep = await prisma.prepBatch.create({ data: { tenantId, itemName: 'Confit garlic', inputs: [], actualYieldQty: 1, staffId: cook } })
  const emp = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: `E-${tag}-${RUN}`, fullName: `Person ${tag}` } })
  const doc = await prisma.hrDocument.create({ data: { tenantId, employeeId: emp.id, docType: 'cnic_front' } })
  const asset = await prisma.fixedAsset.create({ data: { tenantId, name: 'Oven', category: 'kitchen_equipment', acquiredAt: new Date('2026-01-01'), costCents: 500_000, usefulLifeMonths: 60 } })
  return {
    tenantId,
    ids: {
      [RECORD_OWNER.opex_payment]: pay.id, [RECORD_OWNER.supplier_bill]: bill.id, [RECORD_OWNER.goods_receipt]: grn.id,
      [RECORD_OWNER.prep_batch]: prep.id, [RECORD_OWNER.hr_document]: doc.id, [RECORD_OWNER.fixed_asset]: asset.id,
    },
  }
}

const call = (w: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code
const filesOf = (ownerType: string, ownerId: string) =>
  prisma.cashVoucherAttachment.findMany({ where: { kind: RECORD_FILE_KIND, ownerType, ownerId } })

// The actor (company A / company B) that works each owner type by its module's rule.
const ACTOR: Record<string, [string, string]> = {
  [RECORD_OWNER.opex_payment]:  ['finA', 'finB'],
  [RECORD_OWNER.supplier_bill]: ['ceoA', 'ceoB'],
  [RECORD_OWNER.goods_receipt]: ['mgrA', 'mgrB'],
  [RECORD_OWNER.prep_batch]:    ['cookA', 'cookB'],
  [RECORD_OWNER.hr_document]:   ['hrA', 'hrB'],
  [RECORD_OWNER.fixed_asset]:   ['finA', 'finB'],
}

beforeAll(async () => {
  const tA = (await prisma.tenant.create({ data: { name: 'RecFiles A', slug: `recfiles-a-${RUN}` } })).id
  const tB = (await prisma.tenant.create({ data: { name: 'RecFiles B', slug: `recfiles-b-${RUN}` } })).id
  await ensureChartOfAccounts(tA)
  await ensureChartOfAccounts(tB)
  for (const [k, role] of [['ceo', 'admin'], ['fin', 'finance'], ['mgr', 'boh_management'], ['cook', 'boh'], ['hr', 'hr']] as const) {
    await mkUser(`${k}A`, role, tA)
    await mkUser(`${k}B`, role, tB)
  }
  await mkUser('cook2A', 'boh', tA)
  await mkUser('cashierA', 'cashier', tA)
  await mkUser('hrNoModuleA', 'hr', tA, { moduleDeny: ['staff_hr'] })
  await mkUser('finNoCapitalA', 'finance', tA, { moduleDeny: ['capital'] })
  await mkUser('finNoAcctA', 'finance', tA, { moduleDeny: ['accounting'] })
  A = await mkRecords('A', tA, who.cookA!.id)
  B = await mkRecords('B', tB, who.cookB!.id)
  invalidateSetupCache()

  app = Fastify({ bodyLimit: 30 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(recordFileRoutes, { prefix: '/record-files' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
}, 120_000)

afterAll(async () => { invalidateSetupCache(); await app?.close() })

describe('record files: every owner type, two companies', () => {
  it('registers exactly the six owner types', () => {
    expect(recordFileOwnerTypes()).toEqual(Object.values(RECORD_OWNER).sort())
  })

  for (const ownerType of Object.values(RECORD_OWNER)) {
    it(`${ownerType}: A uploads (stamped with the record's company), lists metadata, reads bytes; B gets 404`, async () => {
      const [a, b] = ACTOR[ownerType]!
      const idA = A.ids[ownerType]!
      const up = await call(a, 'POST', `/record-files/${ownerType}/${idA}`, { files: [png(1), pdf] })
      expect(up.statusCode, up.body).toBe(201)
      const saved = (up.json() as { files: Array<{ id: string; mime: string }> }).files
      expect(saved).toHaveLength(2)
      const rows = await filesOf(ownerType, idA)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(rows.every((r) => r.tenantId === A.tenantId && r.kind === RECORD_FILE_KIND)).toBe(true)

      const list = await call(a, 'GET', `/record-files/${ownerType}/${idA}`)
      expect(list.statusCode, list.body).toBe(200)
      const files = (list.json() as { files: Array<Record<string, unknown>> }).files
      for (const f of files) expect(Object.keys(f).sort()).toEqual(['createdAt', 'fileName', 'id', 'mime', 'sizeBytes', 'uploadedByName'])
      expect(list.body).not.toContain(PNG.slice(0, 20))

      const pdfId = saved.find((f) => f.mime === 'application/pdf')!.id
      const get = await call(a, 'GET', `/record-files/${ownerType}/${idA}/${pdfId}`)
      expect(get.statusCode).toBe(200)
      expect(get.headers['content-type']).toBe('application/pdf')
      expect(String(get.headers['content-disposition'])).toMatch(/^inline/)
      expect(get.headers['cache-control']).toBe('private, no-store')
      expect(get.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')

      // Company B: the record does not exist for it.
      expect((await call(b, 'GET', `/record-files/${ownerType}/${idA}`)).statusCode).toBe(404)
      expect((await call(b, 'GET', `/record-files/${ownerType}/${idA}/${pdfId}`)).statusCode).toBe(404)
      expect((await call(b, 'POST', `/record-files/${ownerType}/${idA}`, { files: [png()] })).statusCode).toBe(404)
      // B's own record, A's file id: 404 (no cross-record peek).
      expect((await call(b, 'GET', `/record-files/${ownerType}/${B.ids[ownerType]!}/${pdfId}`)).statusCode).toBe(404)
      expect((await filesOf(ownerType, idA)).length).toBe(rows.length)
    })
  }

  it('an unknown owner type is 404', async () => {
    expect((await call('ceoA', 'GET', `/record-files/order/${A.ids.opex_payment}`)).statusCode).toBe(404)
    expect((await call('ceoA', 'POST', `/record-files/order/${A.ids.opex_payment}`, { files: [png()] })).statusCode).toBe(404)
  })

  it('a bad file → 400 and nothing is written (all checked before any write)', async () => {
    const id = B.ids.opex_payment!
    const before = (await filesOf('opex_payment', id)).length
    const r = await call('finB', 'POST', `/record-files/opex_payment/${id}`, { files: [png(), fakePng] })
    expect(r.statusCode, r.body).toBe(400)
    expect(code(r)).toBe('BAD_FILE')
    // Office files only where the module allows them (not on an OpEx receipt).
    expect((await call('finB', 'POST', `/record-files/opex_payment/${id}`, { files: [docx] })).statusCode).toBe(400)
    expect((await filesOf('opex_payment', id)).length).toBe(before)
  })

  it('Office documents are taken on HR documents and served as an attachment', async () => {
    const id = B.ids.hr_document!
    const r = await call('hrB', 'POST', `/record-files/hr_document/${id}`, { files: [docx] })
    expect(r.statusCode, r.body).toBe(201)
    const f = (r.json() as { files: Array<{ id: string; fileName: string }> }).files[0]!
    expect(f.fileName).toBe('contract.docx')
    const get = await call('hrB', 'GET', `/record-files/hr_document/${id}/${f.id}`)
    expect(get.statusCode).toBe(200)
    expect(String(get.headers['content-disposition'])).toMatch(/^attachment/)
  })

  it('more than 10 files on a record → 409 TOO_MANY_FILES; more than 5 in one call → 400', async () => {
    const id = B.ids.fixed_asset!
    expect((await call('finB', 'POST', `/record-files/fixed_asset/${id}`, { files: [1, 2, 3, 4, 5, 6].map(png) })).statusCode).toBe(400)
    expect((await call('finB', 'POST', `/record-files/fixed_asset/${id}`, { files: [1, 2, 3, 4, 5].map(png) })).statusCode).toBe(201)
    expect((await call('finB', 'POST', `/record-files/fixed_asset/${id}`, { files: [6, 7, 8, 9, 10].map(png) })).statusCode).toBe(201)
    const over = await call('finB', 'POST', `/record-files/fixed_asset/${id}`, { files: [png(11)] })
    expect(over.statusCode, over.body).toBe(409)
    expect(code(over)).toBe('TOO_MANY_FILES')
    expect((await filesOf('fixed_asset', id)).length).toBe(10)
  })
})

describe('record files: each module keeps its own rule', () => {
  it('opex_payment: finance without the capital module is refused (403); a cashier is refused (403)', async () => {
    const id = A.ids.opex_payment!
    expect((await call('finNoCapitalA', 'GET', `/record-files/opex_payment/${id}`)).statusCode).toBe(403)
    expect((await call('finNoCapitalA', 'POST', `/record-files/opex_payment/${id}`, { files: [png()] })).statusCode).toBe(403)
    expect((await call('cashierA', 'GET', `/record-files/opex_payment/${id}`)).statusCode).toBe(403)
  })

  it('supplier_bill: finance reads (AP reader) but cannot attach (bills are entered by managers); a cook is refused', async () => {
    const id = A.ids.supplier_bill!
    expect((await call('finA', 'GET', `/record-files/supplier_bill/${id}`)).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/record-files/supplier_bill/${id}`, { files: [png()] })).statusCode).toBe(403)
    expect((await call('cookA', 'GET', `/record-files/supplier_bill/${id}`)).statusCode).toBe(403)
  })

  it('hr_document: HR (with staff_hr) and the CEO only — finance, a manager and HR without the module are refused', async () => {
    const id = A.ids.hr_document!
    expect((await call('ceoA', 'GET', `/record-files/hr_document/${id}`)).statusCode).toBe(200)
    expect((await call('hrA', 'GET', `/record-files/hr_document/${id}`)).statusCode).toBe(200)
    expect((await call('finA', 'GET', `/record-files/hr_document/${id}`)).statusCode).toBe(403)
    expect((await call('mgrA', 'GET', `/record-files/hr_document/${id}`)).statusCode).toBe(403)
    expect((await call('hrNoModuleA', 'GET', `/record-files/hr_document/${id}`)).statusCode).toBe(403)
    expect((await call('hrNoModuleA', 'POST', `/record-files/hr_document/${id}`, { files: [png()] })).statusCode).toBe(403)
  })

  it('fixed_asset: finance without accounting is refused; a manager who is not a financials viewer is refused', async () => {
    const id = A.ids.fixed_asset!
    expect((await call('finNoAcctA', 'GET', `/record-files/fixed_asset/${id}`)).statusCode).toBe(403)
    expect((await call('mgrA', 'GET', `/record-files/fixed_asset/${id}`)).statusCode).toBe(403)
  })

  it('prep_batch: anyone in the company reads; only its cook or a manager adds photos', async () => {
    const id = A.ids.prep_batch!
    expect((await call('cook2A', 'GET', `/record-files/prep_batch/${id}`)).statusCode).toBe(200)
    expect((await call('cook2A', 'POST', `/record-files/prep_batch/${id}`, { files: [png()] })).statusCode).toBe(403)
    expect((await call('mgrA', 'POST', `/record-files/prep_batch/${id}`, { files: [png()] })).statusCode).toBe(201)
  })

  it('goods_receipt: a cook cannot attach dock photos (managers receive)', async () => {
    expect((await call('cookA', 'POST', `/record-files/goods_receipt/${A.ids.goods_receipt!}`, { files: [png()] })).statusCode).toBe(403)
  })
})

describe('dock receive: uploaded photos satisfy the photo threshold', () => {
  let supA: string, itemA: string
  beforeAll(async () => {
    supA = (await prisma.supplier.create({ data: { name: `Dock ${RUN}`, tenantId: A.tenantId } })).id
    itemA = (await prisma.inventoryItem.create({ data: { name: `Flour ${RUN}`, unit: 'kg', tenantId: A.tenantId, currentStock: 0 } })).id
  })
  const receipts = () => prisma.goodsReceipt.count({ where: { supplierId: supA } })
  const delivery = (extra: Record<string, unknown>) => ({
    supplierId: supA, lines: [{ inventoryItemId: itemA, quantityReceived: 10, unitCostCents: 100_000 }], ...extra,
  })

  it('above the threshold with no photo → 400 PHOTO_REQUIRED; a bad photo → 400, no receipt', async () => {
    const before = await receipts()
    const none = await call('mgrA', 'POST', '/crosschecks/receiving', delivery({}))
    expect(none.statusCode, none.body).toBe(400)
    expect(code(none)).toBe('PHOTO_REQUIRED')
    const bad = await call('mgrA', 'POST', '/crosschecks/receiving', delivery({ photos: [fakePng] }))
    expect(bad.statusCode, bad.body).toBe(400)
    expect(await receipts()).toBe(before)
  })

  it('with photos → 201, the photos are the receipt\'s record files in its company', async () => {
    const r = await call('mgrA', 'POST', '/crosschecks/receiving', delivery({ photos: [png(1), png(2)] }))
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json() as { id: string; tenantId: string; files: Array<{ id: string }> }
    expect(body.tenantId).toBe(A.tenantId)
    expect(body.files).toHaveLength(2)
    const rows = await filesOf('goods_receipt', body.id)
    expect(rows.every((x) => x.tenantId === A.tenantId)).toBe(true)
    const list = await call('mgrA', 'GET', `/record-files/goods_receipt/${body.id}`)
    expect((list.json() as { files: unknown[] }).files).toHaveLength(2)
    expect((await call('mgrB', 'GET', `/record-files/goods_receipt/${body.id}`)).statusCode).toBe(404)
  })
})

describe('Trash purge of an owner erases its files', () => {
  it('purgeRecordFilesTx removes only that record\'s files in its company', async () => {
    const id = A.ids.hr_document!
    const otherCount = (await filesOf('hr_document', B.ids.hr_document!)).length
    expect((await filesOf('hr_document', id)).length).toBeGreaterThan(0)
    await prisma.$transaction((tx) => purgeRecordFilesTx(tx, { ownerType: 'hr_document', ownerId: id, tenantId: A.tenantId }))
    expect(await filesOf('hr_document', id)).toHaveLength(0)
    expect((await filesOf('hr_document', B.ids.hr_document!)).length).toBe(otherCount)
  })
})
