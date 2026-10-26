// The weekly database backup FILE, CEO only (owner S13, 2026-10-26: "make it a
// weekly file i can download and save to my pc.. ceo only..").
//   - no passphrase: no backup (manual 409; weekly recorded failed + the CEO told)
//   - a backup is made, encrypted (no plain dump on disk), and the opener script
//     turns it back into a dump pg_restore reads — with the right passphrase only
//   - changing the passphrase needs the current one
//   - every route is the CEO's (403 for anyone else, the co-owner included)
//   - a download is audited (backup.download); the last 8 are kept
//   - a weekly result reaches the CEO's bell
// Needs pg_dump / pg_restore on the PATH (the API image installs the client).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { issueStaffSession } from '../src/modules/auth/service.js'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'servd-backup-test-'))
process.env['BACKUP_DIR'] = DIR
const { backupRoutes } = await import('../src/modules/backups/routes.js')
const { runBackup, KEY_SETTING, KEEP_BACKUPS } = await import('../src/modules/backups/service.js')

const P = `bkp${Date.now()}`
const PASS = 'correct horse battery staple'
const SCRIPT = path.resolve(__dirname, '../scripts/decrypt-backup.mjs')
let app: FastifyInstance
const tok: Record<string, string> = {}
const ids: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-12', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] } },
  })
  ids[key] = u.id
  tok[key] = issueStaffSession(u).accessToken
}
const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/backups${url}`, payload: payload as never, headers: { authorization: `Bearer ${tok[who]}` } })

function openWith(file: string, passphrase: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, file, out], { env: { ...process.env, SERVD_BACKUP_PASSPHRASE: passphrase }, encoding: 'utf8' })
}

async function waitDone(id: string) {
  for (let i = 0; i < 300; i++) {
    const b = await prisma.databaseBackup.findUniqueOrThrow({ where: { id } })
    if (b.status !== 'running') return b
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('backup did not finish')
}

beforeAll(async () => {
  await prisma.setting.deleteMany({ where: { key: KEY_SETTING } })
  await prisma.databaseBackup.deleteMany({})
  const a = (await prisma.tenant.create({ data: { name: `${P} Company A`, slug: `${P}-a` } })).id
  const b = (await prisma.tenant.create({ data: { name: `${P} Company B`, slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', a)
  await mkUser('owner', 'owner', a)
  await mkUser('mgmt', 'management', b)
  await mkUser('it', 'it', b)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(backupRoutes, { prefix: '/backups' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('only the CEO', () => {
  it('every route is 403 for the co-owner, management and IT', async () => {
    for (const who of ['owner', 'mgmt', 'it']) {
      expect((await call(who, 'GET', '/')).statusCode, who).toBe(403)
      expect((await call(who, 'POST', '/run')).statusCode, who).toBe(403)
      expect((await call(who, 'PUT', '/passphrase', { passphrase: 'another long passphrase' })).statusCode, who).toBe(403)
      expect((await call(who, 'GET', '/00000000-0000-0000-0000-000000000000/download')).statusCode, who).toBe(403)
      expect((await call(who, 'GET', '/opener')).statusCode, who).toBe(403)
    }
  })
})

describe('no passphrase, no backup', () => {
  it('"Make a backup now" is refused; the weekly run is recorded failed and the CEO is told', async () => {
    const s = await call('ceo', 'GET', '/')
    expect(s.statusCode).toBe(200)
    expect(s.json().passphraseSet).toBe(false)
    const r = await call('ceo', 'POST', '/run')
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('BACKUP_PASSPHRASE_REQUIRED')
    const weekly = await runBackup('weekly')
    expect(weekly.status).toBe('failed')
    expect(weekly.error).toMatch(/passphrase/i)
    const bell = await prisma.staffNotification.findFirst({ where: { userId: ids.ceo, kind: 'backup.result', entityId: weekly.id } })
    expect(bell?.title).toBe('Weekly backup failed')
    expect(await prisma.staffNotification.count({ where: { userId: { in: [ids.owner!, ids.mgmt!] }, kind: 'backup.result' } })).toBe(0)
  })
})

describe('a backup, encrypted, opened with the passphrase', () => {
  let backupId = ''
  let file = ''

  it('sets the passphrase (too short refused; never stored in plain)', async () => {
    const short = await call('ceo', 'PUT', '/passphrase', { passphrase: 'short' })
    expect(short.statusCode).toBe(422)
    const r = await call('ceo', 'PUT', '/passphrase', { passphrase: PASS })
    expect(r.statusCode).toBe(200)
    expect(r.json().passphraseSet).toBe(true)
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: KEY_SETTING } })
    expect(row.value).not.toContain(PASS)
    expect(JSON.stringify(r.json())).not.toContain('privateKey')
    expect(await prisma.auditLog.count({ where: { action: 'backup.passphrase_set', userId: ids.ceo } })).toBe(1)
  })

  it('"Make a backup now" answers 202 and writes an encrypted file', async () => {
    const r = await call('ceo', 'POST', '/run')
    expect(r.statusCode).toBe(202)
    backupId = r.json().id
    const b = await waitDone(backupId)
    expect(b.error).toBeNull()
    expect(b.status).toBe('done')
    file = path.join(DIR, b.fileName!)
    const bytes = fs.readFileSync(file)
    expect(bytes.subarray(0, 8).toString('ascii')).toBe('SERVDBK1')
    expect(bytes.length).toBe(b.sizeBytes)
    // No plain dump anywhere: the custom-format magic and the company names never appear.
    expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false)
    expect(bytes.includes(Buffer.from(`${P} Company A`))).toBe(false)
    expect(fs.readdirSync(DIR).filter((f) => f.endsWith('.part'))).toEqual([])
    const list = (await call('ceo', 'GET', '/')).json()
    expect(list.backups.find((x: { id: string }) => x.id === backupId)).toMatchObject({ status: 'done', fileOnServer: true, currentKey: true })
  }, 120_000)

  it('the opener script with the right passphrase gives a dump pg_restore reads; a wrong one fails', () => {
    const out = path.join(DIR, 'opened.dump')
    const ok = openWith(file, PASS, out)
    expect(ok.status, ok.stderr).toBe(0)
    expect(fs.readFileSync(out).subarray(0, 5).toString('ascii')).toBe('PGDMP')
    const listed = spawnSync('pg_restore', ['--list', out], { encoding: 'utf8' })
    expect(listed.status, listed.stderr).toBe(0)
    expect(listed.stdout).toContain('TABLE public tenants')

    const bad = openWith(file, 'not the passphrase at all', path.join(DIR, 'bad.dump'))
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/Wrong passphrase/)
    expect(fs.existsSync(path.join(DIR, 'bad.dump'))).toBe(false)
  })

  it('a changed byte is caught (the file is authenticated)', () => {
    const copy = path.join(DIR, 'tampered.servdbackup')
    const bytes = fs.readFileSync(file)
    bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0xff
    fs.writeFileSync(copy, bytes)
    const r = openWith(copy, PASS, path.join(DIR, 'tampered.dump'))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/damaged/)
  })

  it('download streams the encrypted file and is audited', async () => {
    const r = await call('ceo', 'GET', `/${backupId}/download`)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="servd-backup-/)
    expect(Buffer.compare(r.rawPayload, fs.readFileSync(file))).toBe(0)
    const a = await prisma.auditLog.findFirst({ where: { action: 'backup.download', entityId: backupId } })
    expect(a?.userId).toBe(ids.ceo)
    expect((await call('ceo', 'GET', '/00000000-0000-0000-0000-000000000000/download')).statusCode).toBe(404)
  })

  it('the opener script can be downloaded by the CEO', async () => {
    const r = await call('ceo', 'GET', '/opener')
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('SERVDBK1')
  })

  it('changing the passphrase needs the current one; old files keep opening with the old one', async () => {
    const wrong = await call('ceo', 'PUT', '/passphrase', { passphrase: 'a brand new passphrase', currentPassphrase: 'nope nope nope' })
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json().error.code).toBe('WRONG_PASSPHRASE')
    const ok = await call('ceo', 'PUT', '/passphrase', { passphrase: 'a brand new passphrase', currentPassphrase: PASS })
    expect(ok.statusCode).toBe(200)
    expect(openWith(file, PASS, path.join(DIR, 'old.dump')).status).toBe(0)
    const list = (await call('ceo', 'GET', '/')).json()
    expect(list.backups.find((x: { id: string }) => x.id === backupId).currentKey).toBe(false)
  })

  it('a weekly backup tells the CEO it is ready, and only the last 8 are kept', async () => {
    // Nine older good backups already on disk.
    for (let i = 0; i < KEEP_BACKUPS + 1; i++) {
      const fileName = `old-${i}.servdbackup`
      fs.writeFileSync(path.join(DIR, fileName), 'x')
      await prisma.databaseBackup.create({ data: { trigger: 'weekly', status: 'done', fileName, sizeBytes: 1, startedAt: new Date(Date.now() - (i + 2) * 86_400_000) } })
    }
    const r = await runBackup('weekly')
    expect(r.status).toBe('done')
    const done = await prisma.databaseBackup.findMany({ where: { status: 'done' }, orderBy: { startedAt: 'desc' } })
    expect(done.length).toBe(KEEP_BACKUPS)
    expect(done[0]!.id).toBe(r.id)
    expect(fs.existsSync(path.join(DIR, `old-${KEEP_BACKUPS}.servdbackup`))).toBe(false)
    const bell = await prisma.staffNotification.findFirst({ where: { userId: ids.ceo, kind: 'backup.result', entityId: r.id } })
    expect(bell?.title).toBe('Weekly backup made')
  }, 120_000)
})
