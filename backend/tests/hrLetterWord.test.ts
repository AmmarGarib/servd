// HR letters from Word files (owner, 2026-10-22): "It should give option to HR
// to add letter in word file, and then it would go for default templete for
// any letter, employee details should be picked through selected employee
// field on auto basis" — and "We don't know HTML language".
//   - a Word file is uploaded onto a built-in letter or as HR's own letter
//   - fields typed in plain words ({{Employee Name}}), even when Word splits
//     them across runs, in the body, a table and the header, are filled for
//     the chosen employee; the rest of the file is untouched
//   - the old {{employee.fullName}} form still works; an unknown field stays
//     visible
//   - print copy (render) comes from the Word file
//   - not a Word file / too large → 400, nothing saved
//   - another company's HR: the letter is 404, its employee 404
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { readDocx, writeZip, fillWordXml, htmlToDocx, docxToHtml } from '../src/lib/docx.js'
import { renderLetter } from '../src/modules/hr/letters.js'

const P = `hlw${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const users: Record<string, string> = {}
const E: Record<string, string> = {}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@hlw.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]}` } })

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const LOGO = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
/** A Word file the way Word writes one: a field split across runs, a table, a header with a picture. */
function wordFile(): Buffer {
  const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>`
    + `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Appointment</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Dear {{Employee</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> Name}}, code {{employee.employeeCode}}.</w:t></w:r></w:p>`
    + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{</w:t></w:r><w:r><w:t>Designation}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    + `<w:p><w:r><w:t>Salary {{Gross Salary}} — {{Favourite colour}} — a &amp; b</w:t></w:r></w:p>`
    + `<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr></w:body></w:document>`
  const header = `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}><w:p><w:r><w:drawing><wp:extent xmlns:wp="x" cx="952500" cy="952500"/><a:blip xmlns:a="y" r:embed="rIdL"/></w:drawing></w:r><w:r><w:t>{{Company Name}}</w:t></w:r></w:p></w:hdr>`
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from(doc) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rIdH" Type="h" Target="header1.xml"/></Relationships>') },
    { name: 'word/header1.xml', data: Buffer.from(header) },
    { name: 'word/_rels/header1.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rIdL" Type="i" Target="media/logo.png"/></Relationships>') },
    { name: 'word/media/logo.png', data: LOGO },
  ])
}
const upload = (buf: Buffer, fileName = 'appointment.docx') => ({ fileName, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64: buf.toString('base64') })
const textOf = (xml: string) => Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)).map((m) => m[1]).join('')

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'HLW Foods A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'HLW Foods B', slug: `${P}-b` } })).id
  await mkUser('hrA', 'hr', T.A)
  await mkUser('hrB', 'hr', T.B)
  E.ali = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Ali <Raza>', status: 'active', joiningDate: new Date('2026-01-01'), grossSalaryCents: 6_000_000 } })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.hrLetterTemplate.deleteMany({ where: { tenantId: { in: [T.A!, T.B!] } } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [T.A!, T.B!] } } })
  await app?.close()
})

describe('Word file pieces', () => {
  it('fills a field Word split across runs, keeps the rest of the paragraph', () => {
    const xml = '<w:p><w:r><w:t>Dear {{Emp</w:t></w:r><w:r><w:t>loyee Name}}, hi</w:t></w:r></w:p><w:p><w:r><w:t>{{Date}}</w:t></w:r></w:p>'
    const out = fillWordXml(xml, (n) => (n === 'Employee Name' ? 'A & B' : n === 'Date' ? '1 Nov' : null))
    expect(textOf(out)).toBe('Dear A &amp; B, hi1 Nov')
  })
  it('never matches across paragraphs', () => {
    const xml = '<w:p><w:r><w:t>{{Employee</w:t></w:r></w:p><w:p><w:r><w:t>Name}}</w:t></w:r></w:p>'
    expect(fillWordXml(xml, () => 'X')).toBe(xml)
  })
  it('turns a typed letter into a Word file and back', () => {
    const buf = htmlToDocx('<p style="text-align:center"><strong>Hello</strong> {{Employee Name}}</p><table><tr><td>a</td><td>b</td></tr></table>')
    const html = docxToHtml(buf)
    expect(html).toContain('<strong>Hello</strong>')
    expect(html).toContain('{{Employee Name}}')
    expect(html).toContain('text-align:center')
  })
  it('plain-word fields and the old form both render; unknown stays visible', () => {
    const r = renderLetter('<p>{{Employee Name}} / {{employee.fullName}} / {{ joining date }} / {{Nope}}</p>', { employee: { fullName: 'Sara', joiningDate: '1 Jan 2026' } })
    expect(r.html).toBe('<p>Sara / Sara / 1 Jan 2026 / [Nope]</p>')
    expect(r.missing).toEqual(['Nope'])
  })
})

describe('a Word file on a built-in letter', () => {
  it('uploads, lists as a Word letter with its fields', async () => {
    const r = await call('hrA', 'PUT', '/letters/appointment_letter/word', { file: upload(wordFile()) })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().placeholders).toEqual(expect.arrayContaining(['Employee Name', 'employee.employeeCode', 'Designation', 'Gross Salary', 'Favourite colour', 'Company Name']))
    const list = (await call('hrA', 'GET', '/letters')).json() as Array<{ key: string; hasWord: boolean; wordFileName: string; body: string }>
    expect(list.find((l) => l.key === 'appointment_letter')).toMatchObject({ hasWord: true, wordFileName: 'appointment.docx', body: '' })
    // Typing over it is refused while the Word file is the letter; a new title is fine.
    expect((await call('hrA', 'PUT', '/letters/appointment_letter', { title: 'Appointment', body: '<p>x</p>' })).statusCode).toBe(409)
    expect((await call('hrA', 'PUT', '/letters/appointment_letter', { title: 'Appointment (Word)' })).statusCode).toBe(200)
  })

  it('downloads the Word file filled for the chosen employee — header, table and split runs; nothing else changed', async () => {
    const r = await call('hrA', 'GET', `/letters/appointment_letter/word?employeeId=${E.ali}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toContain('wordprocessingml')
    expect(String(r.headers['content-disposition'])).toContain('Ali')
    const parts = readDocx(r.rawPayload)
    const body = textOf(parts.get('word/document.xml')!.toString())
    expect(body).toContain('Dear Ali &lt;Raza&gt;, code ' + `${P}-1`)
    expect(body).toContain('Salary Rs 60,000')
    expect(body).toContain('{{Favourite colour}}') // unknown: left for HR to see
    expect(body).toContain('a &amp; b')
    expect(textOf(parts.get('word/header1.xml')!.toString())).toBe('HLW Foods A')
    expect(parts.get('word/media/logo.png')).toEqual(LOGO)
    expect(parts.get('word/document.xml')!.toString()).toContain('<w:i/>')
    // Without an employee: the blank Word file as uploaded.
    const blank = await call('hrA', 'GET', '/letters/appointment_letter/word')
    expect(textOf(readDocx(blank.rawPayload).get('word/document.xml')!.toString())).toContain('{{Employee Name}}')
  })

  it('prints from the Word file (header picture included)', async () => {
    const r = (await call('hrA', 'POST', '/letters/render', { key: 'appointment_letter', employeeId: E.ali })).json()
    expect(r.title).toBe('Appointment (Word)')
    expect(r.html).toContain('Ali &lt;Raza&gt;')
    expect(r.html).toContain('HLW Foods A')
    expect(r.html).toContain('data:image/png;base64')
    expect(r.missing).toEqual(['Designation', 'Favourite colour']) // no designation on file yet
  })

  it('removing the Word file puts its text in the letter box', async () => {
    expect((await call('hrA', 'DELETE', '/letters/appointment_letter/word')).statusCode).toBe(204)
    const l = ((await call('hrA', 'GET', '/letters')).json() as Array<{ key: string; hasWord: boolean; body: string }>).find((x) => x.key === 'appointment_letter')!
    expect(l.hasWord).toBe(false)
    expect(l.body).toContain('{{Employee Name}}')
  })

  it('a letter with no Word file downloads as Word with plain-word fields', async () => {
    const r = await call('hrA', 'GET', '/letters/warning_letter/word')
    expect(r.statusCode).toBe(200)
    const text = textOf(readDocx(r.rawPayload).get('word/document.xml')!.toString())
    expect(text).toContain('{{Employee Name}}')
    expect(text).not.toContain('employee.fullName')
  })

  it('refuses a file that is not Word, or too large; nothing saved', async () => {
    const notWord = await call('hrA', 'PUT', '/letters/warning_letter/word', { file: { fileName: 'x.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64: Buffer.from('hello').toString('base64') } })
    expect(notWord.statusCode).toBe(400)
    const pdf = await call('hrA', 'PUT', '/letters/warning_letter/word', { file: { fileName: 'x.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4').toString('base64') } })
    expect(pdf.statusCode).toBe(400)
    const big = await call('hrA', 'PUT', '/letters/warning_letter/word', { file: upload(writeZip([{ name: 'word/document.xml', data: Buffer.from('<w:document/>') }, { name: 'word/media/big.png', data: randomBytes(900_000) }])) })
    expect(big.statusCode).toBe(400)
    expect(big.json().error.code).toBe('WORD_FILE_TOO_LARGE')
    expect(await prisma.hrLetterTemplate.count({ where: { tenantId: T.A, key: 'warning_letter' } })).toBe(0)
  })
})

describe("HR's own letter", () => {
  let key = ''
  it('adds a letter from a Word file, in the active company', async () => {
    const r = await call('hrA', 'POST', '/letters', { title: 'Uniform issue letter', file: upload(wordFile(), 'uniform.docx') })
    expect(r.statusCode, r.body).toBe(201)
    key = r.json().key
    expect(key).toMatch(/^custom_[0-9a-f]{10}$/)
    const row = await prisma.hrLetterTemplate.findFirstOrThrow({ where: { key } })
    expect(row).toMatchObject({ tenantId: T.A, custom: true, wordFileName: 'uniform.docx' })
    const list = (await call('hrA', 'GET', '/letters')).json() as Array<{ key: string; custom: boolean }>
    expect(list.find((l) => l.key === key)?.custom).toBe(true)
  })
  it('adds a typed letter too; an empty one is refused', async () => {
    const r = await call('hrA', 'POST', '/letters', { title: 'Note', body: '<p>Hi {{Employee Name}}</p>' })
    expect(r.statusCode).toBe(201)
    expect((await call('hrA', 'POST', '/letters', { title: 'Empty' })).statusCode).toBe(400)
    const out = (await call('hrA', 'POST', '/letters/render', { key: r.json().key, employeeId: E.ali })).json()
    expect(out.html).toBe('<p>Hi Ali &lt;Raza&gt;</p>')
  })
  it("another company's HR cannot see, fill, change or remove it", async () => {
    const listB = (await call('hrB', 'GET', '/letters')).json() as Array<{ key: string }>
    expect(listB.some((l) => l.key === key)).toBe(false)
    expect((await call('hrB', 'GET', `/letters/${key}/word`)).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/letters/${key}/preview`)).statusCode).toBe(404)
    expect((await call('hrB', 'PUT', `/letters/${key}/word`, { file: upload(wordFile()) })).statusCode).toBe(404)
    expect((await call('hrB', 'PUT', `/letters/${key}`, { title: 'Mine' })).statusCode).toBe(404)
    // Company A's employee is not B's to fill a letter for.
    expect((await call('hrB', 'GET', `/letters/warning_letter/word?employeeId=${E.ali}`)).statusCode).toBe(404)
    await call('hrB', 'DELETE', `/letters/${key}`)
    expect(await prisma.hrLetterTemplate.count({ where: { key } })).toBe(1)
  })
  it('removing it parks it in the Trash', async () => {
    expect((await call('hrA', 'DELETE', `/letters/${key}`)).statusCode).toBe(204)
    expect(await prisma.hrLetterTemplate.count({ where: { key } })).toBe(0)
    expect((await call('hrA', 'GET', `/letters/${key}/word`)).statusCode).toBe(404)
  })
})
