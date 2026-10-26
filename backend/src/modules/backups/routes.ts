// CEO → Backups (owner S13, 2026-10-26). Every route is the CEO's only
// (ADMIN_ONLY) — a backup is every company's data. Module `backups` (CEO
// workspace, CEO_ONLY_MODULES). Contract: modules/backups/service.ts header.
//
//   GET  /backups                 status: passphrase set?, storage, the list
//   POST /backups/run             make one now → 202 (runs in the background)
//   GET  /backups/:id/download    the ENCRYPTED file (audit backup.download)
//   PUT  /backups/passphrase      set / change the passphrase (never stored)
//   GET  /backups/opener          the stand-alone opener script (decrypt-backup.mjs)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'
import { isSandbox } from '../../lib/sandbox.js'
import { MIN_PASSPHRASE } from './crypto.js'
import { readKeyBundle, setPassphrase, beginBackup, backupFilePath, backupDir, KEEP_BACKUPS } from './service.js'

/** The opener script: next to the compiled API in the image (Dockerfile), or the source tree. */
function openerPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const p of [
    path.resolve(process.cwd(), 'scripts/decrypt-backup.mjs'),
    path.resolve(here, '../../../scripts/decrypt-backup.mjs'),
    path.resolve(here, '../../../../scripts/decrypt-backup.mjs'),
  ]) if (fs.existsSync(p)) return p
  return null
}

export async function backupRoutes(fastify: FastifyInstance) {
  fastify.get('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const [bundle, rows] = await Promise.all([
      readKeyBundle(),
      prisma.databaseBackup.findMany({ orderBy: { startedAt: 'desc' }, take: 30 }),
    ])
    return {
      passphraseSet: !!bundle,
      keyId: bundle?.keyId ?? null,
      passphraseSetAt: bundle?.setAt ?? null,
      minPassphrase: MIN_PASSPHRASE,
      keep: KEEP_BACKUPS,
      schedule: 'Every Sunday at 03:00 (Pakistan time)',
      weeklyOn: process.env['ENABLE_WORKERS'] === 'true' && !isSandbox(),
      practiceCopy: isSandbox(),
      storage: 'disk',
      openerAvailable: openerPath() !== null,
      backups: rows.map((b) => ({
        id: b.id, status: b.status, trigger: b.trigger, fileName: b.fileName, sizeBytes: b.sizeBytes,
        keyId: b.keyId, currentKey: !!bundle && b.keyId === bundle.keyId,
        error: b.error, startedAt: b.startedAt, finishedAt: b.finishedAt,
        fileOnServer: b.status === 'done' && !!b.fileName && fs.existsSync(path.join(backupDir(), path.basename(b.fileName))),
      })),
    }
  })

  fastify.post('/run', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    if (isSandbox()) throw new AppError('PRACTICE_NO_BACKUPS', 'The practice copy makes no backups.', 503)
    const me = req.staffUser!
    const b = await beginBackup('manual', me.id)
    // Logged when it finishes (the request returns at once — a big database takes minutes).
    void b.done.then((r) => audit({
      category: 'identity', action: 'backup.manual', entity: 'DatabaseBackup', entityId: r.id,
      userId: me.id, userEmail: me.email ?? null, tenantId: null, after: { status: r.status },
    })).catch(() => undefined)
    return reply.status(202).send({ id: b.id, status: b.status })
  })

  fastify.get<{ Params: { id: string } }>('/:id/download', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const f = await backupFilePath(req.params.id)
    await audit({
      category: 'identity', action: 'backup.download', entity: 'DatabaseBackup', entityId: req.params.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: null,
      metadata: { fileName: f.fileName, sizeBytes: f.size, ip: req.ip ?? null },
    })
    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Length', String(f.size))
    reply.header('Content-Disposition', `attachment; filename="${f.fileName}"`)
    reply.header('Cache-Control', 'no-store')
    return reply.send(fs.createReadStream(f.path))
  })

  fastify.put('/passphrase', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      passphrase: z.string().min(1).max(200),
      currentPassphrase: z.string().max(200).optional(),
      replaceForgotten: z.boolean().optional(),
    }).parse(req.body ?? {})
    const r = await setPassphrase({ id: req.staffUser!.id, email: req.staffUser!.email ?? null }, body)
    return { passphraseSet: true, keyId: r.keyId, passphraseSetAt: r.setAt }
  })

  fastify.get('/opener', { preHandler: requireAuth(...ADMIN_ONLY) }, async (_req, reply) => {
    const p = openerPath()
    if (!p) throw new AppError('NOT_FOUND', 'The opener script is not in this build.', 404)
    reply.header('Content-Type', 'text/javascript; charset=utf-8')
    reply.header('Content-Disposition', 'attachment; filename="decrypt-backup.mjs"')
    return reply.send(fs.readFileSync(p))
  })
}
