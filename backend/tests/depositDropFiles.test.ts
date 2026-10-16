// Deposit slips are FILES, not a URL (owner, 2026-10-16: "it should ask for
// attachment instead of URL for supporting docs").
//
//   • POST /trustops/deposit-drops takes `files` (0–5, JPEG / PNG / WebP / PDF,
//     magic bytes checked BEFORE anything is written) — saved with the drop in
//     one transaction, stamped with the ACTIVE company;
//   • POST /trustops/deposit-drops/:id/files adds slips later (≤ 5 per drop,
//     409 TOO_MANY_FILES) and resolves that drop's "no deposit slip" flag;
//   • GET /trustops/deposit-drops/:id/files/:fileId serves the bytes inline;
//   • the list carries file metadata only, never bytes;
//   • company B gets 404 on everything of company A's;
//   • the legacy receiptUrl is still accepted.
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
import { trustopsRoutes } from '../src/modules/trustops/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; bank: string }
let A: Co, B: Co

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64')
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]).toString('base64')
const png = (n = 1) => ({ fileName: `slip-${n}.png`, mime: 'image/png', dataBase64: PNG })
const pdf = { fileName: 'teller receipt.pdf', mime: 'application/pdf', dataBase64: PDF }

async function mkCo(name: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  const bank = (await prisma.bankAccount.create({ data: { tenantId, name: `HBL ${name}`, accountCode: '1020' } })).id
  return { tenantId, bank }
}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@depslip.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (w: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code
const dropCount = (tenantId: string) => prisma.depositDrop.count({ where: { tenantId } })
const noSlipFlags = (dropId: string) => prisma.exceptionFlag.findMany({ where: { entityType: 'DepositDrop', entityId: dropId, title: { contains: 'deposit slip' } } })

beforeAll(async () => {
  A = await mkCo('DepSlip A')
  B = await mkCo('DepSlip B')
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('finB', 'finance', B.tenantId)
  app = Fastify({ bodyLimit: 30 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.ready()
}, 90_000)

afterAll(async () => { await app?.close() })

describe('deposit drops: slips are files', () => {
  it('create with files binds the drop and its files to the active company; list has metadata only', async () => {
    const r = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 250_000, bankAccountId: A.bank, slipNumber: `S-${RUN}-1`, files: [png(1), pdf] })
    expect(r.statusCode, r.body).toBe(201)
    const drop = r.json() as { id: string; tenantId: string; files: Array<{ id: string; fileName: string; mime: string }> }
    expect(drop.tenantId).toBe(A.tenantId)
    expect(drop.files.map((f) => f.mime).sort()).toEqual(['application/pdf', 'image/png'])
    const rows = await prisma.cashVoucherAttachment.findMany({ where: { depositDropId: drop.id } })
    expect(rows).toHaveLength(2)
    expect(rows.every((x) => x.tenantId === A.tenantId && x.kind === 'deposit_slip')).toBe(true)
    expect(rows.find((x) => x.mime === 'application/pdf')!.fileName).toBe('teller receipt.pdf')
    // ≥ PKR 1,000 with a file → no "no deposit slip" flag.
    expect(await noSlipFlags(drop.id)).toHaveLength(0)

    const list = await call('finA', 'GET', '/trustops/deposit-drops')
    const mine = (list.json() as Array<{ id: string; files: Array<Record<string, unknown>> }>).find((d) => d.id === drop.id)!
    expect(mine.files).toHaveLength(2)
    for (const f of mine.files) {
      expect(Object.keys(f).sort()).toEqual(['createdAt', 'fileName', 'id', 'mime', 'sizeBytes'])
    }
    expect(list.body).not.toContain(PNG.slice(0, 20))

    // The bytes, inline.
    const pdfId = drop.files.find((f) => f.mime === 'application/pdf')!.id
    const get = await call('finA', 'GET', `/trustops/deposit-drops/${drop.id}/files/${pdfId}`)
    expect(get.statusCode).toBe(200)
    expect(get.headers['content-type']).toBe('application/pdf')
    expect(String(get.headers['content-disposition'])).toMatch(/^inline/)
    expect(get.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('company B gets 404 on A\'s drop: not listed, file GET 404, attach 404', async () => {
    const r = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 5_000, bankAccountId: A.bank, files: [png()] })
    const drop = r.json() as { id: string; files: Array<{ id: string }> }
    const listB = (await call('finB', 'GET', '/trustops/deposit-drops')).json() as Array<{ id: string }>
    expect(listB.some((d) => d.id === drop.id)).toBe(false)
    expect((await call('finB', 'GET', `/trustops/deposit-drops/${drop.id}/files/${drop.files[0]!.id}`)).statusCode).toBe(404)
    expect((await call('finB', 'POST', `/trustops/deposit-drops/${drop.id}/files`, { files: [png()] })).statusCode).toBe(404)
    expect(await prisma.cashVoucherAttachment.count({ where: { depositDropId: drop.id } })).toBe(1)

    // A file of another drop is 404 under this drop's id (no cross-drop peek).
    const other = (await call('finB', 'POST', '/trustops/deposit-drops', { amountCents: 5_000, bankAccountId: B.bank, files: [png()] })).json() as { id: string; tenantId: string; files: Array<{ id: string }> }
    expect(other.tenantId).toBe(B.tenantId)
    expect((await call('finB', 'GET', `/trustops/deposit-drops/${other.id}/files/${drop.files[0]!.id}`)).statusCode).toBe(404)
  })

  it('a bad file (wrong mime / fake magic) → 400 and no drop is created', async () => {
    const before = await dropCount(A.tenantId)
    const html = { fileName: 'x.html', mime: 'text/html', dataBase64: Buffer.from('<html><script>alert(1)</script>' + ' '.repeat(40)).toString('base64') }
    const fake = { fileName: 'x.png', mime: 'image/png', dataBase64: Buffer.from('not really a png at all, just text padding padding').toString('base64') }
    for (const bad of [html, fake]) {
      const r = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 150_000, bankAccountId: A.bank, files: [png(), bad] })
      expect(r.statusCode, r.body).toBe(400)
      expect(code(r)).toBe('BAD_FILE')
    }
    expect(await dropCount(A.tenantId)).toBe(before)
  })

  it('more than 5 files: 400 on create; attach past 5 → 409 TOO_MANY_FILES', async () => {
    const before = await dropCount(A.tenantId)
    const six = [1, 2, 3, 4, 5, 6].map(png)
    expect((await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 5_000, bankAccountId: A.bank, files: six })).statusCode).toBe(400)
    expect(await dropCount(A.tenantId)).toBe(before)

    const drop = (await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 5_000, bankAccountId: A.bank, files: [1, 2, 3, 4].map(png) })).json() as { id: string }
    const over = await call('finA', 'POST', `/trustops/deposit-drops/${drop.id}/files`, { files: [png(5), png(6)] })
    expect(over.statusCode).toBe(409)
    expect(code(over)).toBe('TOO_MANY_FILES')
    const ok = await call('finA', 'POST', `/trustops/deposit-drops/${drop.id}/files`, { files: [png(5)] })
    expect(ok.statusCode).toBe(201)
    expect(await prisma.cashVoucherAttachment.count({ where: { depositDropId: drop.id } })).toBe(5)
  })

  it('no slip on a drop ≥ PKR 1,000 flags it; attaching later resolves only that drop\'s flag, in the drop\'s company', async () => {
    const d1 = (await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 120_000, bankAccountId: A.bank })).json() as { id: string }
    const d2 = (await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 130_000, bankAccountId: A.bank })).json() as { id: string }
    const small = (await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 99_999, bankAccountId: A.bank })).json() as { id: string }
    expect(await noSlipFlags(small.id)).toHaveLength(0)
    const [f1] = await noSlipFlags(d1.id)
    expect(f1!.status).toBe('open')
    expect(f1!.tenantId).toBe(A.tenantId)
    expect(f1!.description).toContain('no deposit slip attached')

    const att = await call('finA', 'POST', `/trustops/deposit-drops/${d1.id}/files`, { files: [pdf] })
    expect(att.statusCode, att.body).toBe(201)
    const row = await prisma.cashVoucherAttachment.findFirstOrThrow({ where: { depositDropId: d1.id } })
    expect(row.tenantId).toBe(A.tenantId)
    expect((await noSlipFlags(d1.id))[0]!.status).toBe('resolved')
    expect((await noSlipFlags(d2.id))[0]!.status).toBe('open')

    // A bad file on attach writes nothing.
    const bad = await call('finA', 'POST', `/trustops/deposit-drops/${d2.id}/files`, { files: [{ fileName: 'a.png', mime: 'image/png', dataBase64: PDF }] })
    expect(bad.statusCode).toBe(400)
    expect(await prisma.cashVoucherAttachment.count({ where: { depositDropId: d2.id } })).toBe(0)
    expect((await noSlipFlags(d2.id))[0]!.status).toBe('open')
  })

  it('the legacy receiptUrl is still accepted (and counts as the slip)', async () => {
    const r = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 200_000, bankAccountId: A.bank, receiptUrl: 'https://example.com/slip.jpg' })
    expect(r.statusCode, r.body).toBe(201)
    expect((r.json() as { receiptUrl: string; files: unknown[] }).receiptUrl).toBe('https://example.com/slip.jpg')
    expect(await noSlipFlags((r.json() as { id: string }).id)).toHaveLength(0)
  })
})
