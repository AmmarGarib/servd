// Weekly database backup FILE, CEO only (owner S13, 2026-10-26: "make it a
// weekly file i can download and save to my pc.. ceo only..").
//
//   • Made by the API: `pg_dump --format=custom` of the whole database
//     (every company), streamed straight into the encrypted file
//     (backups/crypto.ts) — the plain dump never touches the disk.
//   • Weekly: Sunday 03:00 PKT (workers/databaseBackup.ts, ENABLE_WORKERS,
//     never on the practice copy); "Make a backup now" on CEO → Backups.
//   • No passphrase set → no backup runs (the weekly one is recorded failed
//     and the CEO is told on the bell).
//   • Stored on the API box's disk: BACKUP_DIR (default /app/backups — a
//     docker volume, deploy/docker-compose.yml `servd_backups`), never in the
//     public media bucket. The last KEEP_BACKUPS good ones are kept.
//   • The database login: BACKUP_DATABASE_URL, else MIGRATE_DATABASE_URL (the
//     table owner — a non-owner login under RLS would dump empty tables), else
//     DATABASE_URL. The password goes to pg_dump through PGPASSWORD, never argv.
//   • Bell notice to every CEO login when a WEEKLY backup succeeds or fails.
// Nothing here logs or returns the passphrase, the database URL or a key.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { notifyStaffMany } from '../../lib/staffNotify.js'
import { isSandbox } from '../../lib/sandbox.js'
import { makeKeyBundle, passphraseMatches, startFile, MIN_PASSPHRASE, type BackupKeyBundle } from './crypto.js'

export const KEEP_BACKUPS = 8
export const KEY_SETTING = 'backup.key'
const FILE_EXT = '.servdbackup'
const STALE_RUNNING_MS = 6 * 3600_000

export function backupDir(): string {
  return process.env['BACKUP_DIR'] || path.resolve(process.cwd(), 'backups')
}

export async function readKeyBundle(): Promise<BackupKeyBundle | null> {
  const row = await prisma.setting.findUnique({ where: { key: KEY_SETTING } })
  if (!row) return null
  try {
    const b = JSON.parse(row.value) as BackupKeyBundle
    return b && b.v === 1 && b.publicKey && b.privateKey ? b : null
  } catch { return null }
}

/** Set (or change) the backup passphrase. The passphrase itself is never stored. */
export async function setPassphrase(
  actor: { id: string; email: string | null },
  input: { passphrase: string; currentPassphrase?: string; replaceForgotten?: boolean },
): Promise<{ keyId: string; setAt: string }> {
  const p = input.passphrase ?? ''
  if (p.trim().length < MIN_PASSPHRASE) {
    throw new AppError('PASSPHRASE_TOO_SHORT', `Use at least ${MIN_PASSPHRASE} characters — a short sentence is easiest to remember.`, 422)
  }
  const current = await readKeyBundle()
  if (current && !input.replaceForgotten) {
    if (!input.currentPassphrase || !passphraseMatches(input.currentPassphrase, current)) {
      throw new AppError('WRONG_PASSPHRASE', 'The current backup passphrase is not right.', 403)
    }
  }
  const bundle = makeKeyBundle(p)
  await prisma.setting.upsert({
    where: { key: KEY_SETTING },
    create: { key: KEY_SETTING, value: JSON.stringify(bundle) },
    update: { value: JSON.stringify(bundle) },
  })
  await audit({
    category: 'identity', action: current ? 'backup.passphrase_change' : 'backup.passphrase_set',
    entity: 'DatabaseBackup', entityId: null, userId: actor.id, userEmail: actor.email, tenantId: null,
    metadata: { keyId: bundle.keyId, previousKeyId: current?.keyId ?? null, replacedForgotten: !!(current && input.replaceForgotten) },
  })
  return { keyId: bundle.keyId, setAt: bundle.setAt }
}

/** A database URL pg_dump accepts (libpq query parameters only) and its password, kept apart. */
export function pgDumpTarget(): { url: string; password: string | null } {
  const raw = process.env['BACKUP_DATABASE_URL'] || process.env['MIGRATE_DATABASE_URL'] || process.env['DATABASE_URL']
  if (!raw) throw new AppError('BACKUP_NO_DATABASE', 'No database address is configured.', 500)
  const u = new URL(raw)
  const password = u.password ? decodeURIComponent(u.password) : null
  u.password = ''
  const LIBPQ = new Set(['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'options', 'connect_timeout', 'channel_binding', 'target_session_attrs', 'application_name'])
  for (const k of [...u.searchParams.keys()]) if (!LIBPQ.has(k)) u.searchParams.delete(k)
  return { url: u.toString(), password }
}

/** Never let a URL (or anything after "password") reach an error row or the page. */
function scrub(s: string): string {
  return s.replace(/postgres(ql)?:\/\/\S+/gi, '[database]').replace(/password\S*/gi, 'password…').slice(0, 400)
}

function fileNameFor(at: Date): string {
  const k = new Date(at.getTime() + 5 * 3600_000).toISOString() // PKT
  return `servd-backup-${k.slice(0, 10)}-${k.slice(11, 13)}${k.slice(14, 16)}${k.slice(17, 19)}${FILE_EXT}`
}

/** Stream pg_dump through the cipher into `dest`. Resolves with the file size. */
async function dumpEncrypted(bundle: BackupKeyBundle, dest: string): Promise<number> {
  const { url, password } = pgDumpTarget()
  const { header, cipher } = startFile(bundle)
  const out = fs.createWriteStream(dest, { mode: 0o600 })
  out.write(header)
  const child = spawn(process.env['PG_DUMP_PATH'] || 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--dbname', url], {
    env: { ...process.env, ...(password !== null && { PGPASSWORD: password }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString() })
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT'
      ? new Error('pg_dump is not installed in the API image (it needs the PostgreSQL client).')
      : err))
    child.on('close', (code) => resolve(code ?? 1))
  })
  // The GCM tag goes after the ciphertext.
  const tagger = new Transform({
    transform(chunk, _enc, cb) { cb(null, cipher.update(chunk)) },
    flush(cb) { const fin = cipher.final(); this.push(fin); this.push(cipher.getAuthTag()); cb() },
  })
  const piped = pipeline(child.stdout, tagger, out)
  const [code] = await Promise.all([exited, piped])
  if (code !== 0) throw new Error(`pg_dump stopped (exit ${code}): ${scrub(stderr.trim()) || 'no detail'}`)
  return fs.statSync(dest).size
}

/** Delete all but the newest KEEP_BACKUPS good backups (files + rows), and old failed rows. */
async function prune(): Promise<void> {
  const done = await prisma.databaseBackup.findMany({ where: { status: 'done' }, orderBy: { startedAt: 'desc' }, select: { id: true, fileName: true, startedAt: true } })
  const extra = done.slice(KEEP_BACKUPS)
  for (const b of extra) {
    if (b.fileName) { try { fs.unlinkSync(path.join(backupDir(), b.fileName)) } catch { /* already gone */ } }
    await prisma.databaseBackup.delete({ where: { id: b.id } }).catch(() => undefined)
  }
  const oldest = done[Math.min(done.length, KEEP_BACKUPS) - 1]?.startedAt
  if (oldest) await prisma.databaseBackup.deleteMany({ where: { status: 'failed', startedAt: { lt: oldest } } })
}

async function tellCeo(row: { id: string; status: string; error: string | null; sizeBytes: number | null }): Promise<void> {
  const ceos = await prisma.user.findMany({ where: { role: 'admin', isActive: true, accountStatus: 'active', deletedAt: null }, select: { id: true } })
  if (ceos.length === 0) return
  const ok = row.status === 'done'
  const mb = row.sizeBytes != null ? `${(row.sizeBytes / 1_048_576).toFixed(1)} MB` : ''
  await notifyStaffMany(ceos.map((c) => ({
    userId: c.id, tenantId: null, kind: 'backup.result' as const,
    severity: ok ? 'success' as const : 'critical' as const,
    title: ok ? 'Weekly backup made' : 'Weekly backup failed',
    body: ok ? `The weekly database backup is ready to download${mb ? ` (${mb})` : ''}.` : (row.error ?? 'The backup did not finish.'),
    link: '/ceo/backups', entityType: 'DatabaseBackup', entityId: row.id, dedupeKey: `backup:${row.id}`,
  })))
}

let busy = false

export interface BackupResult { id: string; status: string; error: string | null }

/**
 * Start one backup. `trigger` weekly (the worker) or manual (the CEO's button).
 * Returns once the row exists; `done` settles when the file is written (or
 * failed). One at a time per process; a row left `running` for 6 h is marked
 * failed.
 */
export async function beginBackup(trigger: 'weekly' | 'manual', actorId: string | null = null): Promise<{ id: string; status: string; done: Promise<BackupResult> }> {
  if (busy) throw new AppError('BACKUP_RUNNING', 'A backup is already being made — wait for it to finish.', 409)
  busy = true
  let started = false
  try {
    await prisma.databaseBackup.updateMany({
      where: { status: 'running', startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      data: { status: 'failed', error: 'Stopped before it finished (the API restarted).', finishedAt: new Date() },
    })
    if (await prisma.databaseBackup.findFirst({ where: { status: 'running' }, select: { id: true } })) {
      throw new AppError('BACKUP_RUNNING', 'A backup is already being made — wait for it to finish.', 409)
    }
    const bundle = await readKeyBundle()
    if (!bundle) {
      if (trigger === 'manual') throw new AppError('BACKUP_PASSPHRASE_REQUIRED', 'Set a backup passphrase first — no backup is made without one.', 409)
      const row = await prisma.databaseBackup.create({ data: { trigger, status: 'failed', error: 'No backup passphrase is set, so no backup was made. Set one on CEO → Backups.', finishedAt: new Date() } })
      await tellCeo({ id: row.id, status: row.status, error: row.error, sizeBytes: null }).catch(() => undefined)
      const r = { id: row.id, status: row.status, error: row.error }
      return { id: row.id, status: row.status, done: Promise.resolve(r) }
    }
    const startedAt = new Date()
    const fileName = fileNameFor(startedAt)
    const row = await prisma.databaseBackup.create({ data: { trigger, status: 'running', fileName, keyId: bundle.keyId, createdById: actorId, startedAt } })
    const done = (async (): Promise<BackupResult> => {
      const dir = backupDir()
      const part = path.join(dir, `${fileName}.part`)
      let r: BackupResult & { sizeBytes: number | null }
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        const size = await dumpEncrypted(bundle, part)
        fs.renameSync(part, path.join(dir, fileName))
        await prisma.databaseBackup.update({ where: { id: row.id }, data: { status: 'done', sizeBytes: size, finishedAt: new Date() } })
        await prune().catch((e) => console.warn('[backup] prune failed:', (e as Error).message))
        r = { id: row.id, status: 'done', error: null, sizeBytes: size }
      } catch (err) {
        try { fs.unlinkSync(part) } catch { /* nothing written */ }
        const error = scrub((err as Error).message || 'The backup did not finish.')
        console.error('[backup] failed:', error)
        await prisma.databaseBackup.update({ where: { id: row.id }, data: { status: 'failed', error, finishedAt: new Date() } }).catch(() => undefined)
        r = { id: row.id, status: 'failed', error, sizeBytes: null }
      } finally {
        busy = false
      }
      if (trigger === 'weekly') await tellCeo(r).catch(() => undefined)
      return { id: r.id, status: r.status, error: r.error }
    })()
    started = true
    return { id: row.id, status: row.status, done }
  } finally {
    if (!started) busy = false
  }
}

/** Make one backup and wait for it. */
export async function runBackup(trigger: 'weekly' | 'manual', actorId: string | null = null): Promise<BackupResult> {
  const b = await beginBackup(trigger, actorId)
  return b.done
}

/** The weekly run (worker). Never on the practice copy. */
export async function runWeeklyBackup(): Promise<void> {
  if (isSandbox()) return
  await runBackup('weekly')
}

/** Absolute path of a finished backup's file, or 404. */
export async function backupFilePath(id: string): Promise<{ path: string; fileName: string; size: number }> {
  const b = await prisma.databaseBackup.findUnique({ where: { id } })
  if (!b || b.status !== 'done' || !b.fileName) throw new AppError('NOT_FOUND', 'Backup not found', 404)
  const p = path.join(backupDir(), path.basename(b.fileName))
  if (!fs.existsSync(p)) throw new AppError('BACKUP_FILE_MISSING', 'This backup file is no longer on the server.', 410)
  return { path: p, fileName: path.basename(b.fileName), size: fs.statSync(p).size }
}
