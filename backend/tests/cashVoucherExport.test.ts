// Cash voucher PDF / Excel exports (2026-10-15). Vouchers are inserted
// directly so this does not depend on the raise/approve routes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { cashVoucherExportRoutes } from '../src/modules/trustops/voucherExport.js'
import { amountInWords } from '../src/lib/amountInWords.js'
import { buildXlsx } from '../src/lib/xlsxWriter.js'

const P = `cve${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const V: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, tenant: string) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cv.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenant, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: tenant } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const get = (key: string, url: string) =>
  app.inject({ method: 'GET', url: `/api/v1/trustops/cash-vouchers${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` } })

async function mkVoucher(tenantId: string, seq: number, status: string, extra: Record<string, unknown> = {}) {
  return (await prisma.cashVoucher.create({
    data: {
      tenantId, seq, number: `CV-${String(seq).padStart(5, '0')}`, voucherDate: new Date(), payeeName: '=cmd|calc Vendor <&> Ltd',
      purpose: 'Kitchen repair & parts', category: 'transport', amountCents: 12_345_600, status: status as never,
      preparedById: U['ceoA']!.id, ...extra,
    },
  })).id
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Export Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Export Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  await mkUser('ceoA', 'admin', T.A)
  await mkUser('ceoB', 'admin', T.B)
  V['approved'] = await mkVoucher(T.A, 1, 'approved', {
    directorSignedById: U['ceoA']!.id, directorSignedAt: new Date(), kind: 'expense', grossCents: 12_845_600, discountCents: 500_000,
  })
  V['submitted'] = await mkVoucher(T.A, 2, 'submitted')
  V['posted'] = await mkVoucher(T.A, 3, 'posted', { cashierName: 'Jamil' })
  await prisma.cashVoucherAttachment.create({
    data: { tenantId: T.A, voucherId: V['approved']!, kind: 'supporting', mime: 'application/pdf', fileName: 'invoice-77.pdf', sizeBytes: 4, data: Buffer.from('%PDF'), uploadedById: U['ceoA']!.id },
  })
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(cashVoucherExportRoutes, { prefix: '/trustops/cash-vouchers' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('cash voucher exports', () => {
  it('PDF: %PDF header, attachment headers, audited', async () => {
    const r = await get('ceoA', `/${V['approved']}/export.pdf`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toBe('application/pdf')
    expect(r.headers['content-disposition']).toBe('attachment; filename="CV-00001.pdf"')
    expect(r.headers['cache-control']).toBe('private, no-store')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const a = await prisma.auditLog.findFirst({ where: { action: 'cash_voucher.export', entityId: V['approved'] } })
    expect(a?.tenantId).toBe(T.A)
  })

  it('PDF of a posted voucher with odd characters still renders', async () => {
    const r = await get('ceoA', `/${V['posted']}/export.pdf`)
    expect(r.statusCode, r.body).toBe(200)
  })

  it('XLSX: a valid zip with the number, total and escaped text', async () => {
    const r = await get('ceoA', `/${V['approved']}/export.xlsx`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(r.headers['content-disposition']).toBe('attachment; filename="CV-00001.xlsx"')
    const buf = r.rawPayload
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const count = buf.readUInt16LE(eocd + 10)
    expect(count).toBe(6)
    // Walk the central directory: names + CRCs of the stored entries.
    let p = buf.readUInt32LE(eocd + 16)
    const names: string[] = []
    for (let i = 0; i < count; i++) {
      const nameLen = buf.readUInt16LE(p + 28)
      names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
      p += 46 + nameLen
    }
    expect(names).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']))
    const xml = buf.toString('utf8')
    expect(xml).toContain('CV-00001')
    expect(xml).toContain('<v>123456</v>') // total PKR 123,456.00
    expect(xml).toContain('<v>5000</v>') // discount
    expect(xml).toContain('invoice-77.pdf')
    expect(xml).toContain('Export Co A')
    expect(xml).toContain('CASH PAYMENT VOUCHER')
    // Text that looks like a formula stays an escaped inline string.
    expect(xml).toContain('t="inlineStr"><is><t xml:space="preserve">=cmd|calc Vendor &lt;&amp;&gt; Ltd')
    expect(xml).toContain('One Lakh Twenty Three Thousand Four Hundred Fifty Six Only')
  })

  it('409 NOT_APPROVED before approval', async () => {
    for (const f of ['pdf', 'xlsx']) {
      const r = await get('ceoA', `/${V['submitted']}/export.${f}`)
      expect(r.statusCode).toBe(409)
      expect(r.json().error.code).toBe('NOT_APPROVED')
    }
  })

  it("company B gets 404 on company A's voucher", async () => {
    for (const f of ['pdf', 'xlsx']) expect((await get('ceoB', `/${V['approved']}/export.${f}`)).statusCode).toBe(404)
  })

  it('helpers: words and a hand-built workbook', () => {
    expect(amountInWords(25_000_000)).toBe('Pakistani Rupees Two Lakh Fifty Thousand Only')
    expect(buildXlsx({ name: 'x', rows: [['a']] }).length).toBeGreaterThan(100)
  })
})
